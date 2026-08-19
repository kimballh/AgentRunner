import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgentRunStore } from "./store.js";
import type { ServiceConfig } from "./types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;
const schema = `agentrunner_test_${Date.now()}`;
let pool: Pool;
let store: AgentRunStore;
let config: ServiceConfig;

maybeDescribe("AgentRunStore integration", () => {
  beforeAll(async () => {
    config = serviceConfig(databaseUrl!, schema);
    pool = new Pool({ connectionString: databaseUrl });
    store = new AgentRunStore(config);
    await store.setup();
  });

  afterAll(async () => {
    await store?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  test("claims by priority and updates success", async () => {
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, agent_provider)
       VALUES
       ('queued', '{}'::jsonb, 'low', 'low', NOW(), 1, 'codex'),
       ('queued', '{}'::jsonb, 'high', 'high', NOW(), 10, 'claude')`,
    );

    const claimed = await store.claimNext("worker-1");
    expect(claimed?.row.uid).toBe("high");
    expect(claimed?.resolved.provider).toBe("claude");

    await store.markSucceeded(claimed!.row.id, "worker-1", {
      exitCode: 0,
      lastMessage: "done\u0000now",
      logs: "logs\u0000continued",
      conversation: { aggregatedOutput: "value\u0000separator" },
      result: { output: "result\u0000separator" },
    });

    const updated = await store.getRun(claimed!.row.id);
    expect(updated?.status).toBe("succeeded");
    expect(updated?.last_message).toBe("done\ufffdnow");
    expect(updated?.logs).toBe("logs\ufffdcontinued");
    expect(updated?.conversation).toEqual({ aggregatedOutput: "value\ufffdseparator" });
    expect(updated?.result).toEqual({ output: "result\ufffdseparator" });
  });

  test("sanitizes NUL characters while persisting a failed run", async () => {
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, agent_provider)
       VALUES ('queued', '{}'::jsonb, 'failure', 'failure', NOW(), 1003, 'codex')`,
    );

    const claimed = await store.claimNext("failure-worker");
    await store.markFailed(claimed!.row.id, "failure-worker", claimed!.row, new Error("failed\u0000reason"), {
      exitCode: 1,
      lastMessage: "partial\u0000message",
      logs: "partial\u0000logs",
      conversation: { output: "partial\u0000conversation" },
      result: { output: "partial\u0000result" },
    });

    const updated = await store.getRun(claimed!.row.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.last_message).toBe("partial\ufffdmessage");
    expect(updated?.logs).toBe("partial\ufffdlogs");
    expect(updated?.conversation).toEqual({ output: "partial\ufffdconversation" });
    expect(updated?.result).toEqual({ output: "partial\ufffdresult" });
    expect(updated?.error).toMatchObject({ message: "failed\ufffdreason" });
  });

  test("claims only runs assigned to a worker's provider", async () => {
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, agent_provider)
       VALUES
       ('queued', '{}'::jsonb, 'provider codex', 'provider-codex', NOW(), 1002, 'codex'),
       ('queued', '{}'::jsonb, 'provider claude', 'provider-claude', NOW(), 1001, 'claude')`,
    );

    const claude = await store.claimNext("claude-worker", "claude");
    const codex = await store.claimNext("codex-worker", "codex");

    expect(claude?.row.uid).toBe("provider-claude");
    expect(claude?.resolved.provider).toBe("claude");
    expect(codex?.row.uid).toBe("provider-codex");
    expect(codex?.resolved.provider).toBe("codex");

    await store.markSucceeded(claude!.row.id, "claude-worker", { exitCode: 0, logs: "done" });
    await store.markSucceeded(codex!.row.id, "codex-worker", { exitCode: 0, logs: "done" });
  });

  test("cancels a running job without retrying it", async () => {
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, agent_provider, num_retries)
       VALUES ('queued', '{}'::jsonb, 'cancel me', 'cancel-me', NOW(), 1000, 'codex', 3)`,
    );

    const claimed = await store.claimNext("cancel-worker");
    expect(claimed?.row.uid).toBe("cancel-me");
    expect(await store.requestCancellation(claimed!.row.id)).toMatchObject({
      outcome: "requested",
      lockedBy: "cancel-worker",
    });
    expect(await store.heartbeat(claimed!.row.id, "cancel-worker")).toBe(true);
    expect(await store.markSucceeded(claimed!.row.id, "cancel-worker", { exitCode: 0, logs: "too late" })).toBe(
      false,
    );
    expect(await store.markCancelled(claimed!.row.id, "cancel-worker", { exitCode: 1, logs: "partial" })).toBe(true);

    const updated = await store.getRun(claimed!.row.id);
    expect(updated?.status).toBe("cancelled");
    expect(updated?.logs).toBe("partial");
    expect(updated?.error).toMatchObject({ message: "cancelled by user" });
    expect(await store.requestCancellation(claimed!.row.id)).toEqual({ outcome: "not-running" });
  });

  test("manually retries a failed run exactly once", async () => {
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, finished_at, priority, attempts, num_retries)
       VALUES ('failed', '{}'::jsonb, 'try again', 'manual-retry', NOW(), NOW(), 900, 3, 2)
       RETURNING id`,
    );
    const id = inserted.rows[0].id;

    expect(await store.retryFailedRun(id)).toBe("queued");
    expect(await store.retryFailedRun(id)).toBe("not-failed");

    const queued = await store.getRun(id);
    expect(queued).toMatchObject({ status: "retry", attempts: 3, num_retries: 3, finished_at: null });

    const claimed = await store.claimNext("manual-retry-worker");
    expect(claimed?.row.id).toBe(id);
    expect(claimed?.row.attempts).toBe(4);
    await store.markFailed(id, "manual-retry-worker", claimed!.row, { message: "still failing" });
    expect((await store.getRun(id))?.status).toBe("failed");
  });

  test("returns all narrow cleanup candidates and excludes persisted removals", async () => {
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, finished_at, priority, worktree_path)
       SELECT 'succeeded', '{}'::jsonb, 'cleanup', 'cleanup-' || value, NOW(), NOW(), 0, '/tmp/worktree-' || value
       FROM generate_series(1, 105) AS value
       RETURNING id`,
    );
    await store.markWorktreeRemoved(inserted.rows[0].id, "removed in test");

    const candidateRows = await store.completedRunsOldestFirst();
    const candidates = candidateRows.map((run) => run.id);

    expect(candidates).toHaveLength(104);
    expect(candidates).not.toContain(inserted.rows[0].id);
    expect(candidateRows.every((run) => run.status === "succeeded")).toBe(true);
    expect(Object.keys(candidateRows[0]).sort()).toEqual(["branch_name", "id", "status", "worktree_path"]);
    const removed = await store.getRun(inserted.rows[0].id);
    expect(removed?.worktree_removed_at).toBeInstanceOf(Date);
  });

  test("serializes cleanup locks across store instances", async () => {
    const secondStore = new AgentRunStore(config);
    let active = 0;
    let maxActive = 0;
    const operation = async (): Promise<void> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
    };

    try {
      await Promise.all([
        store.withWorktreeCleanupLock("/tmp/shared-repo", operation),
        secondStore.withWorktreeCleanupLock("/tmp/shared-repo", operation),
      ]);
    } finally {
      await secondStore.close();
    }

    expect(maxActive).toBe(1);
  });

  test("claims the latest successful matching session with its original provider configuration", async () => {
    const source = await pool.query<{ id: number }>(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, finished_at, priority,
        agent_provider, agent_mode, model_name, reasoning_effort, session_id,
        repo_path, worktree_path, branch_name, base_branch)
       VALUES
       ('succeeded', '{}'::jsonb, 'first test', 'HAR-900::Bot Testing', NOW() - INTERVAL '1 minute', NOW(), 0,
        'claude', 'exec', 'claude-opus-5', 'high', 'session-har-900',
        '/tmp/repo', '/tmp/repo/.worktrees/test', 'agentrunner/test', 'origin/project')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, reuse_session,
        agent_provider, model_name)
       VALUES
       ('queued', '{}'::jsonb, 'test again', 'HAR-900::Bot Testing', NOW(), 100, true,
        'codex', 'gpt-5.6-sol')`,
    );

    const claimed = await store.claimNext("reuse-worker");

    expect(claimed?.row.reused_from_run_id).toBe(source.rows[0].id);
    expect(claimed?.row.session_id).toBe("session-har-900");
    expect(claimed?.row.worktree_path).toBe("/tmp/repo/.worktrees/test");
    expect(claimed?.resolved).toMatchObject({ provider: "claude", modelName: "claude-opus-5", reasoningEffort: "high" });
    expect(claimed?.requested).toMatchObject({ provider: "codex", modelName: "gpt-5.6-sol" });
    expect(claimed?.row.requested_agent_provider).toBe("codex");
    expect(claimed?.row.requested_model_name).toBe("gpt-5.6-sol");
    expect((await store.completedRunsOldestFirst()).map((run) => run.worktree_path)).not.toContain(
      "/tmp/repo/.worktrees/test",
    );

    await store.markSucceeded(claimed!.row.id, "reuse-worker", {
      exitCode: 0,
      sessionId: "session-har-900",
      logs: "resumed",
    });
  });

  test("does not lease one reusable session to two active runs", async () => {
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, finished_at, priority,
        agent_provider, agent_mode, session_id, repo_path, worktree_path)
       VALUES
       ('succeeded', '{}'::jsonb, 'source', 'HAR-901::Bot Testing', NOW() - INTERVAL '1 minute', NOW(), 0,
        'codex', 'exec', 'session-har-901', '/tmp/repo', '/tmp/repo/.worktrees/test-901');
       INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, reuse_session)
       VALUES
       ('queued', '{}'::jsonb, 'one', 'HAR-901::Bot Testing', NOW(), 90, true),
       ('queued', '{}'::jsonb, 'two', 'HAR-901::Bot Testing', NOW() + INTERVAL '1 millisecond', 90, true)`,
    );

    const first = await store.claimNext("lease-worker-1");
    const second = await store.claimNext("lease-worker-2");

    expect(first?.row.session_id).toBe("session-har-901");
    expect(second?.row.session_id).toBeNull();
    expect(second?.row.reuse_fallback_reason).toContain("no available successful run");

    await store.markSucceeded(first!.row.id, "lease-worker-1", { exitCode: 0, logs: "done" });
    await store.markSucceeded(second!.row.id, "lease-worker-2", { exitCode: 0, sessionId: "fresh-901", logs: "done" });
  });

  test("preserves the originally requested configuration through a reuse retry and fallback", async () => {
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, finished_at, priority,
        agent_provider, agent_mode, model_name, reasoning_effort, session_id,
        repo_path, worktree_path, branch_name, base_branch)
       VALUES
       ('succeeded', '{}'::jsonb, 'source', 'HAR-902::Bot Testing', NOW() - INTERVAL '1 minute', NOW(), 0,
        'claude', 'exec', 'claude-opus-5', 'high', 'session-har-902',
        '/tmp/repo-902', '/tmp/repo-902/.worktrees/test', 'agentrunner/test', 'origin/project');
       INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, reuse_session,
        agent_provider, agent_mode, model_name, reasoning_effort, base_branch, num_retries)
       VALUES
       ('queued', '{}'::jsonb, 'test', 'HAR-902::Bot Testing', NOW(), 80, true,
        'codex', 'exec', 'gpt-5.6-sol', 'xhigh', 'origin/requested', 1)`,
    );

    const first = await store.claimNext("retry-worker-1");
    expect(first?.resolved.provider).toBe("claude");
    expect(first?.requested).toMatchObject({ provider: "codex", modelName: "gpt-5.6-sol", reasoningEffort: "xhigh" });
    expect(first?.requestedBaseBranch).toBe("origin/requested");
    await store.markFailed(first!.row.id, "retry-worker-1", first!.row, { message: "retry" });

    const retry = await store.claimNext("retry-worker-2");
    expect(retry?.resolved.provider).toBe("claude");
    expect(retry?.requested).toMatchObject({ provider: "codex", modelName: "gpt-5.6-sol", reasoningEffort: "xhigh" });
    expect(retry?.requestedBaseBranch).toBe("origin/requested");

    const fallback = await store.abandonSessionReuse(
      retry!.row.id,
      "retry-worker-2",
      retry!.requested,
      retry!.requestedBaseBranch,
      "test fallback",
    );
    expect(fallback).toMatchObject({
      agent_provider: "codex",
      agent_mode: "exec",
      model_name: "gpt-5.6-sol",
      reasoning_effort: "xhigh",
      base_branch: "origin/requested",
      session_id: null,
      reused_from_run_id: null,
    });
    await store.markSucceeded(fallback.id, "retry-worker-2", { exitCode: 0, sessionId: "fresh-902", logs: "done" });
  });

  test("waits for cleanup before leasing a reusable worktree", async () => {
    const source = await pool.query<{ id: number }>(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, finished_at, priority,
        agent_provider, agent_mode, session_id, repo_path, worktree_path)
       VALUES
       ('succeeded', '{}'::jsonb, 'source', 'HAR-903::Bot Testing', NOW() - INTERVAL '1 minute', NOW(), 0,
        'codex', 'exec', 'session-har-903', '/tmp/repo-903', '/tmp/repo-903/.worktrees/test')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, reuse_session)
       VALUES ('queued', '{}'::jsonb, 'test', 'HAR-903::Bot Testing', NOW(), 70, true)`,
    );

    const secondStore = new AgentRunStore(config);
    let releaseCleanup!: () => void;
    const cleanupCanFinish = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupAcquired!: () => void;
    const cleanupIsLocked = new Promise<void>((resolve) => {
      cleanupAcquired = resolve;
    });
    const cleanup = store.withWorktreeCleanupLock("/tmp/repo-903", async () => {
      cleanupAcquired();
      await cleanupCanFinish;
      await store.markWorktreeRemoved(source.rows[0].id, "removed during race test");
    });
    await cleanupIsLocked;

    let claimSettled = false;
    const claimPromise = secondStore.claimNext("cleanup-race-worker").then((claim) => {
      claimSettled = true;
      return claim;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(claimSettled).toBe(false);
    } finally {
      releaseCleanup();
    }
    await cleanup;
    const claimed = await claimPromise;
    await secondStore.close();

    expect(claimed?.row.session_id).toBeNull();
    expect(claimed?.row.reused_from_run_id).toBeNull();
    expect(claimed?.row.reuse_fallback_reason).toContain("no available successful run");
    await store.markSucceeded(claimed!.row.id, "cleanup-race-worker", {
      exitCode: 0,
      sessionId: "fresh-903",
      logs: "done",
    });
  });
});

function serviceConfig(url: string, databaseSchema: string): ServiceConfig {
  return {
    cwd: "/tmp",
    configPath: "/tmp/agentrunner_config.toml",
    databaseUrl: url,
    databaseUrlEnvVar: "TEST_DATABASE_URL",
    databaseSchema,
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
