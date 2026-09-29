import { beforeAll, describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK, createRemoteJWKSet } from "jose";
import type { IncomingMessage } from "node:http";
import { createAuthenticator } from "./mcp-auth.js";
import { validateMcpConfig } from "./mcp-config.js";
import type { McpConfig } from "./types.js";

const config: McpConfig = {
  host: "127.0.0.1",
  port: 8888,
  publicUrl: "https://runner.example/mcp",
  allowedOrigins: [],
  submissionsPerMinute: 30,
  maxPendingJobs: 1000,
  oauth: {
    issuer: "https://auth.example/",
    audience: "https://runner.example/mcp",
    allowedSubjects: ["owner"],
  },
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let authenticate: ReturnType<typeof createAuthenticator>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  authenticate = createAuthenticator(
    config,
    createLocalJWKSet({
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "one", alg: "RS256" }],
    }),
  );
});
async function token(claims: Record<string, unknown> = {}, typ = "at+jwt", alg = "RS256"): Promise<string> {
  return new SignJWT({ scope: "agentrunner:access", ...claims })
    .setProtectedHeader({ alg, typ, kid: "one" })
    .setIssuer(String(claims.iss ?? config.oauth.issuer))
    .setAudience(String(claims.aud ?? config.oauth.audience))
    .setSubject(String(claims.sub ?? "owner"))
    .setIssuedAt()
    .setExpirationTime((claims.exp as number) ?? "15m")
    .sign(keys.privateKey);
}
function request(value?: string): IncomingMessage {
  return { headers: { authorization: value } } as IncomingMessage;
}
describe("MCP authentication", () => {
  test("accepts only correctly scoped owner access tokens", async () => {
    expect(await authenticate(request("Bearer " + (await token())))).toEqual({
      issuer: config.oauth.issuer,
      subject: "owner",
    });
  });
  test.each([{ iss: "https://other.example/" }, { aud: "https://other.example/mcp" }, { exp: 1 }])(
    "rejects invalid token claims %j",
    async (claims) => {
      await expect(authenticate(request("Bearer " + (await token(claims))))).rejects.toMatchObject({ status: 401 });
    },
  );
  test("rejects ID tokens, opaque credentials, and missing credentials", async () => {
    for (const value of [undefined, "Bearer opaque", "Basic secret", "Bearer " + (await token({}, "JWT"))])
      await expect(authenticate(request(value))).rejects.toMatchObject({
        status: 401,
      });
  });
  test.each([
    [{}, "JWT", "invalid_access_token_type"],
    [{ iss: "https://other.example/" }, "at+jwt", "wrong_issuer"],
    [{ aud: "https://other.example/mcp" }, "at+jwt", "wrong_audience"],
    [{ exp: 1 }, "at+jwt", "token_expired"],
    [{ sub: "other" }, "at+jwt", "subject_not_allowed"],
    [{ scope: "openid" }, "at+jwt", "missing_scope"],
  ])("explains authentication failures without exposing token contents", async (claims, typ, reason) => {
    const value = await token(claims, typ);
    const failure = await authenticate(request("Bearer " + value)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason });
    expect(String(failure)).not.toContain(value);
  });
  test("rejects other users and missing scope", async () => {
    await expect(authenticate(request("Bearer " + (await token({ sub: "other" }))))).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
    });
    await expect(authenticate(request("Bearer " + (await token({ scope: "openid" }))))).rejects.toMatchObject({
      status: 403,
      code: "insufficient_scope",
    });
  });
  test("fails closed when keys are unavailable", async () => {
    const auth = createAuthenticator(config, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(auth(request("Bearer " + (await token())))).rejects.toMatchObject({ status: 503 });
  });
  test("rejects unsigned and symmetric tokens", async () => {
    const symmetric = await new SignJWT({ scope: "agentrunner:access" })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(config.oauth.issuer)
      .setAudience(config.oauth.audience)
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new Uint8Array(32));
    await expect(authenticate(request("Bearer " + symmetric))).rejects.toMatchObject({ status: 401 });
  });

  test("refreshes rotated JWKS, uses cached valid keys during an outage, and fails closed on unknown keys", async () => {
    const rotated = await generateKeyPair("RS256");
    let jwks = {
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "one", alg: "RS256" }],
    };
    let available = true;
    const server = createServer((_req, res) => {
      if (!available) {
        res.writeHead(503).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(jwks));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const auth = createAuthenticator(
      config,
      createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/jwks`), {
        cooldownDuration: 0,
      }),
    );
    try {
      expect((await auth(request("Bearer " + (await token())))).subject).toBe("owner");
      jwks = {
        keys: [...jwks.keys, { ...(await exportJWK(rotated.publicKey)), kid: "two", alg: "RS256" }],
      };
      const signed = await new SignJWT({ scope: "agentrunner:access" })
        .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "two" })
        .setIssuer(config.oauth.issuer)
        .setAudience(config.oauth.audience)
        .setSubject("owner")
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(rotated.privateKey);
      expect((await auth(request("Bearer " + signed))).subject).toBe("owner");
      available = false;
      expect((await auth(request("Bearer " + signed))).subject).toBe("owner");
      const unknown = await new SignJWT({ scope: "agentrunner:access" })
        .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "unknown" })
        .setIssuer(config.oauth.issuer)
        .setAudience(config.oauth.audience)
        .setSubject("owner")
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(rotated.privateKey);
      await expect(auth(request("Bearer " + unknown))).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("requires canonical public resource, matching audience and owner allowlist", () => {
    expect(() => validateMcpConfig(config)).not.toThrow();
    for (const override of [
      { publicUrl: "http://runner.example/mcp" },
      { publicUrl: "https://runner.example/mcp/" },
      { oauth: { ...config.oauth, audience: "other" } },
      { oauth: { ...config.oauth, allowedSubjects: [] } },
    ])
      expect(() => validateMcpConfig({ ...config, ...override })).toThrow();
  });
});
