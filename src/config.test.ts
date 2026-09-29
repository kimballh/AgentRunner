import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENTRUNNER_") || key === "CUSTOM_DB_URL") {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadConfig", () => {
  test("MCP has independent defaults and CLI/env/TOML precedence", async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, "agentrunner_config.toml"),
      '[mcp]\nport=7777\npublic_url="https://toml.example/mcp"\n[mcp.oauth]\nissuer="https://auth.example/"\naudience="https://toml.example/mcp"\nallowed_subjects=["owner"]',
    );
    process.env.AGENTRUNNER_DATABASE_URL = "postgres://test/db";
    process.env.AGENTRUNNER_PORT = "4567";
    let config = await loadConfig({}, cwd);
    expect(config.port).toBe(4567);
    expect(config.mcp?.port).toBe(7777);
    process.env.AGENTRUNNER_MCP_PORT = "8889";
    config = await loadConfig({}, cwd);
    expect(config.mcp?.port).toBe(8889);
    config = await loadConfig({ mcpPort: "9999", mcpPublicUrl: "https://cli.example/mcp" }, cwd);
    expect(config.port).toBe(4567);
    expect(config.mcp?.port).toBe(9999);
    expect(config.mcp?.publicUrl).toBe("https://cli.example/mcp");
    expect(config.mcp?.oauth.allowedSubjects).toEqual(["owner"]);
    await expect(loadConfig({ mcpPort: "invalid" }, cwd)).rejects.toThrow("mcp.port must be a number");
  });

  test("MCP auth environment overrides are separate from worker and dashboard defaults", async () => {
    const cwd = await tempDir();
    process.env.AGENTRUNNER_DATABASE_URL = "postgres://test/db";
    process.env.AGENTRUNNER_MCP_OAUTH_ISSUER = "https://auth.example/";
    process.env.AGENTRUNNER_MCP_OAUTH_AUDIENCE = "https://public.example/mcp";
    process.env.AGENTRUNNER_MCP_OAUTH_ALLOWED_SUBJECTS = "owner,second third";
    process.env.AGENTRUNNER_MCP_PUBLIC_URL = "https://public.example/mcp";
    const config = await loadConfig({}, cwd);
    expect(config.port).toBe(0);
    expect(config.mcp?.port).toBe(8888);
    expect(config.mcp?.oauth.allowedSubjects).toEqual(["owner", "second", "third"]);
    expect(config.mcp?.oauth.audience).toBe(config.mcp?.publicUrl);
    expect(config.outputMaxBytes).toBe(33554432);
  });

  test("sources cwd .env and uses custom database URL env var", async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, ".env"),
      ["CUSTOM_DB_URL=postgres://user:pass@localhost/db", "AGENTRUNNER_DATABASE_URL_ENV_VAR=CUSTOM_DB_URL"].join("\n"),
    );

    const config = await loadConfig({}, cwd);

    expect(config.databaseUrlEnvVar).toBe("CUSTOM_DB_URL");
    expect(config.databaseUrl).toBe("postgres://user:pass@localhost/db");
  });

  test("uses CLI overrides before env before TOML before defaults", async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, "agentrunner_config.toml"),
      [
        'database_url_env_var = "CUSTOM_DB_URL"',
        'agent_provider = "claude"',
        'default_agent_provider = "claude"',
        "num_workers = 2",
        "[codex]",
        'default_model = "toml-codex"',
      ].join("\n"),
    );
    process.env.CUSTOM_DB_URL = "postgres://from-custom/db";
    process.env.AGENTRUNNER_AGENT_PROVIDER = "both";
    process.env.AGENTRUNNER_NUM_WORKERS = "3";

    const config = await loadConfig({ agentProvider: "codex", numWorkers: "4" }, cwd);

    expect(config.agentProvider).toBe("codex");
    expect(config.defaultAgentProvider).toBe("claude");
    expect(config.numWorkers).toBe(4);
    expect(config.codex.defaultModel).toBe("toml-codex");
  });

  test("allows print-ddl style config without a database URL", async () => {
    const cwd = await tempDir();
    const config = await loadConfig({}, cwd, { requireDatabaseUrl: false });
    expect(config.databaseUrl).toBe("");
    expect(config.agentProvider).toBe("both");
    expect(config.databaseSchema).toBe("public");
    expect(config.databaseTable).toBe("agent_runs");
    expect(config.git.createWorktrees).toBe("auto");
    expect(config.git.deleteDirtyWorktrees).toBe(false);
    expect(config.preflightRetries).toBe(2);
    expect(config.preflightRetryDelayMs).toBe(1_000);
  });

  test("loads git config and CLI overrides", async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, "agentrunner_config.toml"),
      [
        'database_url_env_var = "CUSTOM_DB_URL"',
        "preflight_retries = 4",
        "[git]",
        'create_worktrees = "never"',
        'base_branch = "origin/dev"',
        'worktree_dir = ".custom-worktrees"',
        "max_worktrees = 10",
        'setup_script = "scripts/setup.sh"',
      ].join("\n"),
    );
    process.env.CUSTOM_DB_URL = "postgres://from-custom/db";
    process.env.AGENTRUNNER_PREFLIGHT_RETRIES = "3";

    const config = await loadConfig(
      {
        createWorktrees: "always",
        maxWorktrees: "3",
        deleteDirtyWorktrees: true,
        preflightRetries: "5",
      },
      cwd,
    );

    expect(config.git.createWorktrees).toBe("always");
    expect(config.git.baseBranch).toBe("origin/dev");
    expect(config.git.worktreeDir).toBe(".custom-worktrees");
    expect(config.git.maxWorktrees).toBe(3);
    expect(config.git.deleteDirtyWorktrees).toBe(true);
    expect(config.git.setupScript).toBe("scripts/setup.sh");
    expect(config.preflightRetries).toBe(5);
  });

  test("rejects mutually exclusive setup settings", async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, "agentrunner_config.toml"),
      [
        'database_url_env_var = "CUSTOM_DB_URL"',
        "[git]",
        'setup_script = "scripts/setup.sh"',
        'setup_command = ["npm", "install"]',
      ].join("\n"),
    );
    process.env.CUSTOM_DB_URL = "postgres://from-custom/db";

    await expect(loadConfig({}, cwd)).rejects.toThrow("mutually exclusive");
  });
});

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-config-"));
}
