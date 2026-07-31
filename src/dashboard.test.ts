import { describe, expect, test } from "vitest";
import { renderRunsPage } from "./dashboard.js";
import type { AgentRunRow, ServiceConfig } from "./types.js";

describe("renderRunsPage", () => {
  test("escapes row values", () => {
    const html = renderRunsPage({
      page: { runs: [listRow({ uid: "<script>x</script>" })], hasMore: false },
      stats: { active: 0, queued: 1, maxWorkers: 1, availableWorkers: 1 },
      config: config(),
    });

    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  test("renders bounded pagination controls", () => {
    const html = renderRunsPage({
      page: { runs: [listRow({ id: 42 })], hasMore: true },
      pagination: { limit: 25 },
      stats: { active: 0, queued: 1, maxWorkers: 1, availableWorkers: 1 },
      config: config(),
    });

    expect(html).toContain("Rows");
    expect(html).toContain("Older");
    expect(html).toContain("before=");
    expect(html).toContain("25</option>");
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
    preflightRetries: 2,
    preflightRetryDelayMs: 0,
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

function listRow(overrides: Partial<ReturnType<typeof row>> & { created_at_cursor?: string } = {}) {
  const base = row(overrides);
  return {
    id: base.id,
    status: base.status,
    uid: base.uid,
    created_at: base.created_at,
    created_at_cursor: overrides.created_at_cursor ?? "2026-01-01T00:00:00.000000",
    finished_at: base.finished_at,
    link: base.link,
    last_message: base.last_message,
    attempts: base.attempts,
    priority: base.priority,
    model_name: base.model_name,
    reasoning_effort: base.reasoning_effort,
    agent_provider: base.agent_provider,
    agent_mode: base.agent_mode,
    num_retries: base.num_retries,
    started_at: base.started_at,
    updated_at: base.updated_at,
    repo_path: base.repo_path,
    worktree_path: base.worktree_path,
    branch_name: base.branch_name,
    base_branch: base.base_branch,
    cleanup_note: base.cleanup_note,
    has_error: base.error !== null,
    has_logs: Boolean(base.logs),
    has_setup_logs: Boolean(base.setup_logs),
    has_conversation: base.conversation !== null,
  };
}
