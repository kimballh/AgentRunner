import { describe, expect, test } from "vitest";
import { resolveRunConfig } from "./selection.js";
import type { AgentRunRow, ServiceConfig } from "./types.js";

describe("resolveRunConfig", () => {
  test("forced global provider overrides row provider", () => {
    const config = serviceConfig({ agentProvider: "codex" });
    const resolved = resolveRunConfig(row({ agent_provider: "claude", model_name: "row-model" }), config);
    expect(resolved.provider).toBe("codex");
    expect(resolved.modelName).toBe("row-model");
  });

  test("both uses row provider when present", () => {
    const config = serviceConfig({ agentProvider: "both", defaultAgentProvider: "codex" });
    const resolved = resolveRunConfig(row({ agent_provider: "claude" }), config);
    expect(resolved.provider).toBe("claude");
    expect(resolved.modelName).toBe("claude-default");
  });

  test("both falls back to default provider when row provider is null", () => {
    const config = serviceConfig({ agentProvider: "both", defaultAgentProvider: "claude" });
    const resolved = resolveRunConfig(row({ agent_provider: null }), config);
    expect(resolved.provider).toBe("claude");
  });
});

function serviceConfig(overrides: Partial<ServiceConfig>): ServiceConfig {
  return {
    cwd: "/tmp",
    configPath: "/tmp/agentrunner_config.toml",
    databaseUrl: "postgres://localhost/db",
    databaseUrlEnvVar: "AGENTRUNNER_DATABASE_URL",
    databaseSchema: "public",
    databaseTable: "agent_runs",
    agentProvider: "both",
    defaultAgentProvider: "codex",
    agentMode: "exec",
    numWorkers: 1,
    pollFrequencyMs: 60_000,
    staleAfterMs: 900_000,
    host: "127.0.0.1",
    port: 0,
    git: {
      createWorktrees: "auto",
      remote: "origin",
      branchPrefix: "agentrunner",
      worktreeDir: ".worktrees",
      maxWorktrees: 25,
      cleanupBatchSize: 5,
      cleanupDeleteBranches: false,
      setup: "auto",
      setupCommand: [],
    },
    codex: {
      bin: "codex",
      defaultModel: "codex-default",
      defaultReasoningEffort: "medium",
      bypassApprovalsAndSandbox: true,
      extraArgs: [],
      appServerExtraArgs: [],
      config: [],
    },
    claude: {
      bin: "claude",
      defaultModel: "claude-default",
      defaultReasoningEffort: "medium",
      extraArgs: [],
    },
    ...overrides,
  };
}

function row(overrides: Partial<AgentRunRow>): AgentRunRow {
  return {
    id: 1,
    status: "queued",
    raw_webhook_data: {},
    prompt: "hello",
    uid: "uid",
    created_at: new Date(),
    finished_at: null,
    link: null,
    last_message: null,
    conversation: null,
    attempts: null,
    logs: null,
    priority: 0,
    error: null,
    model_name: null,
    reasoning_effort: null,
    agent_provider: null,
    agent_mode: null,
    num_retries: null,
    ...overrides,
  };
}
