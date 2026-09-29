import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JWTVerifyGetKey } from "jose";
import type { AgentRunStore } from "./store.js";
import type { ServiceConfig } from "./types.js";
import { createAuthenticator, AuthenticationError } from "./mcp-auth.js";
import { MCP_SCOPE, validateMcpConfig } from "./mcp-config.js";
import { createToolServer } from "./mcp-tools.js";

export async function startMcp(
  config: ServiceConfig,
  store: AgentRunStore,
  options: { keyResolver?: JWTVerifyGetKey } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  if (!config.mcp) throw new Error("MCP configuration is required");
  const mcp = config.mcp;
  validateMcpConfig(mcp);
  await store.queue.validate();
  const publicUrl = new URL(mcp.publicUrl);
  const authenticate = createAuthenticator(mcp, options.keyResolver);
  const origins = new Set([publicUrl.origin, ...mcp.allowedOrigins]);
  const hosts = new Set([
    publicUrl.host,
    `${mcp.host}:${mcp.port}`,
    `127.0.0.1:${mcp.port}`,
    `localhost:${mcp.port}`,
    `[::1]:${mcp.port}`,
  ]);
  const metadata = {
    resource: mcp.publicUrl,
    authorization_servers: [mcp.oauth.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "AgentRunner",
  };
  const inFlight = new Set<Promise<void>>();
  const transports = new Set<StreamableHTTPServerTransport>();
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.headers.host || !hosts.has(req.headers.host.toLowerCase())) {
      respond(res, 403, { error: "invalid_host" });
      return;
    }
    if (req.headers.origin && !origins.has(req.headers.origin)) {
      respond(res, 403, { error: "invalid_origin" });
      return;
    }
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate,MCP-Protocol-Version");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST,GET,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept,MCP-Protocol-Version");
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", publicUrl.origin);
    if (url.searchParams.has("access_token") || url.searchParams.has("token")) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${publicUrl.origin}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}", error="invalid_token"`,
      );
      respond(res, 401, { error: "invalid_token" });
      return;
    }
    if (
      ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname) &&
      req.method === "GET"
    ) {
      respond(res, 200, metadata);
      return;
    }
    if (url.pathname !== "/mcp") {
      respond(res, 404, { error: "not_found" });
      return;
    }
    let principal;
    try {
      principal = await authenticate(req);
    } catch (error) {
      const auth =
        error instanceof AuthenticationError
          ? error
          : new AuthenticationError(503, "authentication_unavailable", "signing_keys_unavailable");
      if (auth.status !== 503)
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${publicUrl.origin}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}", error="${auth.code}", error_description="${auth.message}"`,
        );
      if (req.headers.authorization)
        console.warn(JSON.stringify({ component: "mcp", event: "authentication_failed", status: auth.status, reason: auth.reason }));
      respond(res, auth.status, { error: auth.code, error_description: auth.message, reason: auth.reason });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      respond(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (req.headers["content-type"]?.toLowerCase().split(";")[0]?.trim() !== "application/json") {
      respond(res, 415, { error: "unsupported_media_type" });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      respond(res, (error as { status?: number }).status ?? 400, {
        error: "invalid_request",
      });
      return;
    }
    const server = createToolServer(store.queue, principal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transports.add(transport);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      transports.delete(transport);
      await server.close();
    }
  };
  const listener = createServer((req, res) => {
    const task = handler(req, res).catch(() => {
      if (!res.headersSent) respond(res, 503, { error: "unavailable" });
      else res.end();
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  });
  listener.requestTimeout = 30000;
  listener.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(mcp.port, mcp.host, () => {
      listener.removeListener("error", reject);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    url: `http://${mcp.host}:${mcp.port}/mcp`,
    close: () =>
      (closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
        listener.closeIdleConnections();
        await Promise.allSettled([...inFlight]);
        await Promise.all([...transports].map((t) => t.close()));
        await closed;
      })()),
  };
}
function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"] ?? 0) > 1024 * 1024)
    throw Object.assign(new Error("body too large"), { status: 413 });
  let size = 0;
  const buffers: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
    buffers.push(b);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}
