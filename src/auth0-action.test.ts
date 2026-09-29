import fs from "node:fs/promises";
import vm from "node:vm";
import { beforeAll, describe, expect, test, vi } from "vitest";

let handler: (event: any, api: any) => Promise<void>;
const audience = "https://YOUR-STABLE-NGROK-DOMAIN/mcp";
beforeAll(async () => {
  const context = { exports: {} as { onExecutePostLogin: typeof handler } };
  vm.runInNewContext(await fs.readFile(new URL("../docs/auth0/mcp-allowlist.cjs", import.meta.url), "utf8"), context);
  handler = context.exports.onExecutePostLogin;
});
const event = (user = "owner", resource = audience, subjects = '["owner"]') => ({
  resource_server: { identifier: resource },
  user: { user_id: user },
  secrets: { MCP_ALLOWED_SUBJECTS: subjects },
});
describe("Auth0 MCP login allowlist", () => {
  test("allows the exact owner across dynamically registered clients", async () => {
    for (const client_id of ["dcr-one", "dcr-two"]) {
      const deny = vi.fn();
      await handler({ ...event(), client: { client_id } }, { access: { deny } });
      expect(deny).not.toHaveBeenCalled();
    }
  });
  test("rejects another identity before token issuance", async () => {
    const deny = vi.fn();
    await handler(event("other"), { access: { deny } });
    expect(deny).toHaveBeenCalledWith("This account is not authorized to connect to AgentRunner.");
  });
  test.each(["", "not-json", '{}', '["owner",1]'])("fails closed on invalid allowlist %s", async (subjects) => {
    const deny = vi.fn();
    await handler(event("owner", audience, subjects), { access: { deny } });
    expect(deny).toHaveBeenCalledWith("AgentRunner access policy is not configured.");
  });
  test("leaves other APIs and identity-only logins unaffected", async () => {
    for (const input of [event("other", "https://other-api.example", "invalid"), { user: { user_id: "other" } }]) {
      const deny = vi.fn();
      await handler(input, { access: { deny } });
      expect(deny).not.toHaveBeenCalled();
    }
  });
  test("applies the same policy to a refresh exchange and missing identity", async () => {
    for (const user of ["other", undefined]) {
      const deny = vi.fn();
      await handler({ ...event(), user: { user_id: user }, transaction: { protocol: "oauth2-refresh-token" } }, { access: { deny } });
      expect(deny).toHaveBeenCalledOnce();
    }
  });
});
