import type { McpConfig } from "./types.js";

export const MCP_SCOPE = "agentrunner:access";

export function validateMcpConfig(config: McpConfig): void {
  const publicUrl = secureUrl(config.publicUrl, "mcp.public_url");
  if (publicUrl.pathname !== "/mcp" || publicUrl.search || publicUrl.hash || publicUrl.href !== config.publicUrl) {
    throw new Error("mcp.public_url must be a canonical HTTPS URL ending in /mcp");
  }
  const issuer = secureUrl(config.oauth.issuer, "mcp.oauth.issuer");
  if (issuer.search || issuer.hash || !config.oauth.issuer.endsWith("/"))
    throw new Error("mcp.oauth.issuer must end in /");
  if (config.oauth.audience !== config.publicUrl) throw new Error("mcp.oauth.audience must equal mcp.public_url");
  if (!config.oauth.allowedSubjects.length || config.oauth.allowedSubjects.some((s) => !s.trim())) {
    throw new Error("mcp.oauth.allowed_subjects must contain at least one exact user subject");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("mcp.port must be between 1 and 65535");
  for (const origin of config.allowedOrigins) {
    if (secureUrl(origin, "mcp.allowed_origins").origin !== origin)
      throw new Error("mcp.allowed_origins must contain HTTPS origins");
  }
}

function secureUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is required and must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  return url;
}
