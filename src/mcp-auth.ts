import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IncomingMessage } from "node:http";
import type { McpConfig } from "./types.js";
import type { Principal } from "./queue-api.js";
import { MCP_SCOPE } from "./mcp-config.js";

const AUTH_FAILURES = {
  missing_bearer_token: "An OAuth access token is required in the Authorization header.",
  invalid_access_token_type: "Use an RFC 9068 API access token (at+jwt), not an ID token or Auth0-profile token.",
  wrong_issuer: "The access token issuer does not match the configured OAuth issuer.",
  wrong_audience: "The access token audience must be the configured public MCP URL.",
  token_expired: "The access token has expired; refresh it or reconnect the client.",
  subject_not_allowed: "The authenticated user is not in the configured subject allowlist.",
  missing_scope: `The access token must include the ${MCP_SCOPE} scope.`,
  signing_keys_unavailable: "OAuth signing keys could not be verified; retry when the issuer is available.",
  invalid_token: "The OAuth access token could not be verified.",
} as const;
type AuthenticationFailure = keyof typeof AUTH_FAILURES;

export class AuthenticationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: AuthenticationFailure = "invalid_token",
  ) {
    super(AUTH_FAILURES[reason]);
  }
}
export function createAuthenticator(
  config: McpConfig,
  resolver?: JWTVerifyGetKey,
): (request: IncomingMessage) => Promise<Principal> {
  const keys =
    resolver ??
    createRemoteJWKSet(new URL(".well-known/jwks.json", config.oauth.issuer), {
      timeoutDuration: 5000,
    });
  return async (request) => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !/^Bearer [^\s]+$/i.test(authorization))
      throw new AuthenticationError(401, "invalid_token", "missing_bearer_token");
    try {
      const { payload } = await jwtVerify(authorization.slice(7), keys, {
        issuer: config.oauth.issuer,
        audience: config.oauth.audience,
        algorithms: ["RS256"],
        typ: "at+jwt",
        requiredClaims: ["exp", "sub", "iat"],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== "string" || !config.oauth.allowedSubjects.includes(payload.sub))
        throw new AuthenticationError(403, "access_denied", "subject_not_allowed");
      if (typeof payload.scope !== "string" || !payload.scope.split(/\s+/).includes(MCP_SCOPE))
        throw new AuthenticationError(403, "insufficient_scope", "missing_scope");
      return { issuer: config.oauth.issuer, subject: payload.sub };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      const code = (error as { code?: string }).code ?? "";
      if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JOSE_GENERIC" || error instanceof TypeError)
        throw new AuthenticationError(503, "authentication_unavailable", "signing_keys_unavailable");
      if (code === "ERR_JWT_EXPIRED") throw new AuthenticationError(401, "invalid_token", "token_expired");
      if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
        const claim = (error as { claim?: string }).claim;
        if (claim === "typ") throw new AuthenticationError(401, "invalid_token", "invalid_access_token_type");
        if (claim === "iss") throw new AuthenticationError(401, "invalid_token", "wrong_issuer");
        if (claim === "aud") throw new AuthenticationError(401, "invalid_token", "wrong_audience");
      }
      throw new AuthenticationError(401, "invalid_token");
    }
  };
}
