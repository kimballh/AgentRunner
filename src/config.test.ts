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
  });

  test("loads git config and CLI overrides", async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, "agentrunner_config.toml"),
      [
        'database_url_env_var = "CUSTOM_DB_URL"',
        "[git]",
        'create_worktrees = "never"',
        'base_branch = "origin/dev"',
        'worktree_dir = ".custom-worktrees"',
        "max_worktrees = 10",
        'setup_script = "scripts/setup.sh"',
      ].join("\n"),
    );
    process.env.CUSTOM_DB_URL = "postgres://from-custom/db";

    const config = await loadConfig({ createWorktrees: "always", maxWorktrees: "3" }, cwd);

    expect(config.git.createWorktrees).toBe("always");
    expect(config.git.baseBranch).toBe("origin/dev");
    expect(config.git.worktreeDir).toBe(".custom-worktrees");
    expect(config.git.maxWorktrees).toBe(3);
    expect(config.git.setupScript).toBe("scripts/setup.sh");
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
