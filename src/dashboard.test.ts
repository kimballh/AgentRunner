import { describe, expect, test } from "vitest";
import { renderRunsPage } from "./dashboard.js";
import type { AgentRunRow, ServiceConfig } from "./types.js";

describe("renderRunsPage", () => {
  test("escapes row values", () => {
    const html = renderRunsPage({
      runs: [row({ uid: "<script>x</script>", prompt: "prompt" })],
      stats: { active: 0, queued: 1, maxWorkers: 1, availableWorkers: 1 },
      config: config(),
    });

    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });
});

function config(): ServiceConfig {
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
    codex: { bin: "codex", bypassApprovalsAndSandbox: true, extraArgs: [], appServerExtraArgs: [], config: [] },
    claude: { bin: "claude", extraArgs: [] },
  };
}

function row(overrides: Partial<AgentRunRow>): AgentRunRow {
  return {
    id: 1,
    status: "queued",
    raw_webhook_data: {},
    prompt: "hello",
    uid: "uid",
    created_at: new Date("2026-01-01T00:00:00Z"),
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
