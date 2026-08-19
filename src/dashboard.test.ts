import { describe, expect, test } from "vitest";
import { renderRunsPage, startDashboard } from "./dashboard.js";
import { AgentRunStore } from "./store.js";
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

  test("offers cancellation only for running rows", () => {
    const running = renderRunsPage({
      page: { runs: [listRow({ id: 42, status: "running" })], hasMore: false },
      stats: { active: 1, queued: 0, maxWorkers: 1, availableWorkers: 0 },
      config: config(),
    });
    const queued = renderRunsPage({
      page: { runs: [listRow({ id: 43, status: "queued" })], hasMore: false },
      stats: { active: 0, queued: 1, maxWorkers: 1, availableWorkers: 1 },
      config: config(),
    });

    expect(running).toContain(`onclick="cancelRun(42, this)"`);
    expect(running).toContain(">Stop</button>");
    expect(queued).not.toContain(`onclick="cancelRun(43, this)"`);
  });

  test("shows a requested cancellation as stopping", () => {
    const html = renderRunsPage({
      page: {
        runs: [listRow({ status: "running", cancel_requested_at: new Date("2026-01-01T00:01:00Z") })],
        hasMore: false,
      },
      stats: { active: 1, queued: 0, maxWorkers: 1, availableWorkers: 0 },
      config: config(),
    });

    expect(html).toContain("status-stopping\">stopping");
    expect(html).toContain("disabled>Stopping...</button>");
  });

  test("offers retry only for failed rows", () => {
    const failed = renderRunsPage({
      page: { runs: [listRow({ id: 42, status: "failed" })], hasMore: false },
      stats: { active: 0, queued: 0, maxWorkers: 1, availableWorkers: 1 },
      config: config(),
    });
    const succeeded = renderRunsPage({
      page: { runs: [listRow({ id: 43, status: "succeeded" })], hasMore: false },
      stats: { active: 0, queued: 0, maxWorkers: 1, availableWorkers: 1 },
      config: config(),
    });

    expect(failed).toContain(`onclick="retryRun(42, this)"`);
    expect(failed).toContain(">Retry</button>");
    expect(succeeded).not.toContain(`onclick="retryRun(43, this)"`);
  });
});

describe("dashboard cancellation endpoint", () => {
  test("accepts same-origin cancellation requests", async () => {
    const calls: number[] = [];
    const dashboard = await startDashboard({
      config: config(),
      store: {} as AgentRunStore,
      stats: () => ({ active: 1, queued: 0, maxWorkers: 1, availableWorkers: 0 }),
      cancelRun: async (id) => {
        calls.push(id);
        return "requested";
      },
      retryRun: async () => "not-failed",
    });

    try {
      const url = new URL("/api/runs/42/cancel", dashboard.url);
      const response = await fetch(url, { method: "POST", headers: { origin: url.origin } });
      expect(response.status).toBe(202);
      expect(calls).toEqual([42]);
    } finally {
      await dashboard.close();
    }
  });

  test("rejects cross-origin cancellation requests", async () => {
    const dashboard = await startDashboard({
      config: config(),
      store: {} as AgentRunStore,
      stats: () => ({ active: 1, queued: 0, maxWorkers: 1, availableWorkers: 0 }),
      cancelRun: async () => "requested",
      retryRun: async () => "not-failed",
    });

    try {
      const response = await fetch(new URL("/api/runs/42/cancel", dashboard.url), {
        method: "POST",
        headers: { origin: "https://example.com" },
      });
      expect(response.status).toBe(403);
    } finally {
      await dashboard.close();
    }
  });
});

describe("dashboard retry endpoint", () => {
  test("accepts same-origin retry requests", async () => {
    const calls: number[] = [];
    const dashboard = await startDashboard({
      config: config(),
      store: {} as AgentRunStore,
      stats: () => ({ active: 0, queued: 0, maxWorkers: 1, availableWorkers: 1 }),
      cancelRun: async () => "not-running",
      retryRun: async (id) => {
        calls.push(id);
        return "queued";
      },
    });

    try {
      const url = new URL("/api/runs/42/retry", dashboard.url);
      const response = await fetch(url, { method: "POST", headers: { origin: url.origin } });
      expect(response.status).toBe(202);
      expect(calls).toEqual([42]);
    } finally {
      await dashboard.close();
    }
  });

  test("rejects retrying a run that is no longer failed", async () => {
    const dashboard = await startDashboard({
      config: config(),
      store: {} as AgentRunStore,
      stats: () => ({ active: 0, queued: 1, maxWorkers: 1, availableWorkers: 1 }),
      cancelRun: async () => "not-running",
      retryRun: async () => "not-failed",
    });

    try {
      const url = new URL("/api/runs/42/retry", dashboard.url);
      const response = await fetch(url, { method: "POST", headers: { origin: url.origin } });
      expect(response.status).toBe(409);
    } finally {
      await dashboard.close();
    }
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
    reuse_session: base.reuse_session,
    session_id: base.session_id,
    reused_from_run_id: base.reused_from_run_id,
    reuse_fallback_reason: base.reuse_fallback_reason,
    cancel_requested_at: base.cancel_requested_at,
    has_error: base.error !== null,
    has_logs: Boolean(base.logs),
    has_setup_logs: Boolean(base.setup_logs),
    has_conversation: base.conversation !== null,
  };
}
