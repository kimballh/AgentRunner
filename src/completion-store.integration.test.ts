import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createCompletionReceipt, persistCompletion, type CompletionReceipt } from "./completion.js";
import { AgentRunStore } from "./store.js";
import type { ServiceConfig } from "./types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const schema = `agentrunner_completion_${Date.now()}_${randomUUID().slice(0, 8)}`;
const table = `"${schema}"."agent_runs"`;
let pool: Pool;
let store: AgentRunStore;
let config: ServiceConfig;

/** Only synthesized rows in a uniquely named test schema; never starts a worker or provider. */
integration("completion persistence integration", () => {
  beforeAll(async () => {
    config = serviceConfig(databaseUrl!, schema);
    pool = new Pool({ connectionString: databaseUrl });
    store = new AgentRunStore(config);
    await store.setup();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${table} RESTART IDENTITY CASCADE`);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await store?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  async function claim(worker = "completion-worker", retries = 0): Promise<CompletionReceipt> {
    await pool.query(
      `INSERT INTO ${table} (status,raw_webhook_data,prompt,uid,created_at,priority,agent_provider,num_retries)
       VALUES ('queued','{}','synthetic test only','test',NOW(),0,'codex',$1)`, [retries],
    );
    const run = (await store.claimNext(worker))!;
    return createCompletionReceipt(run.row.id, run.row.attempts!, worker, {
      exitCode: 0, logs: "successful logs", lastMessage: "completed", result: { external_changes: "synthetic only" },
      conversation: { text: "successful output" }, outputComplete: true,
    });
  }
  async function attempt(receipt: CompletionReceipt): Promise<Record<string, any>> {
    return (await pool.query(`SELECT * FROM "${schema}"."agent_runs_attempts" WHERE run_id=$1 AND attempt_number=$2`,
      [receipt.runId, receipt.attemptNumber])).rows[0];
  }
  async function expire(receipt: CompletionReceipt): Promise<void> {
    await pool.query(`UPDATE ${table} SET heartbeat_at=NOW()-interval '1 day' WHERE id=$1`, [receipt.runId]);
  }

  test("saves run and matching receipt atomically, and exact replays are idempotent", async () => {
    const receipt = await claim();
    expect(await store.markExecutionStarted(receipt.runId, receipt.workerId, receipt.attemptNumber)).toBe(true);
    const outcomes = await Promise.all([store.completeSuccess(receipt), store.completeSuccess(receipt)]);
    expect(outcomes).toEqual(["succeeded", "succeeded"]);
    const first = await attempt(receipt);
    expect(first.metadata).toMatchObject({ execution_started: true, completion_digest: receipt.digest });
    expect(first).toMatchObject({ status: "succeeded", exit_code: 0, output_complete: true, result: receipt.result.result });
    expect(await store.readCompletion(receipt)).toBe("succeeded");
    expect(await store.completeSuccess(receipt)).toBe("succeeded");
    expect((await attempt(receipt)).finished_at).toEqual(first.finished_at);
    const row = await store.getRun(receipt.runId);
    expect(row).toMatchObject({ status: "succeeded", logs: receipt.result.logs, conversation: receipt.result.conversation, exit_code: 0 });
  });

  test("different concurrent receipts cannot mix payloads or acknowledge another digest", async () => {
    const first = await claim();
    const second = createCompletionReceipt(first.runId, first.attemptNumber, first.workerId,
      { exitCode: 0, logs: "other logs", result: { output: "other" } });
    const outcomes = await Promise.all([store.completeSuccess(first), store.completeSuccess(second)]);
    expect(outcomes.sort()).toEqual(["stale", "succeeded"]);
    const saved = await attempt(first);
    const winner = saved.metadata.completion_digest === first.digest ? first : second;
    const loser = winner === first ? second : first;
    expect(await store.readCompletion(winner)).toBe("succeeded");
    expect(await store.readCompletion(loser)).toBe("stale");
    expect((await store.getRun(first.runId))?.logs).toBe(winner.result.logs);
    expect(saved.result).toEqual(winner.result.result);
  });

  test.each([true, false])("derives output completeness from the exact durable finalizing marker: %s", async (markerPresent) => {
    const original = await claim();
    const receipt = createCompletionReceipt(original.runId, original.attemptNumber, original.workerId,
      { ...original.result, outputComplete: !markerPresent, journalEndSequence: 2 });
    await store.queue.append(receipt.runId, receipt.attemptNumber, receipt.workerId, [
      { sequence: 1, source: "logs", kind: "stdout", text: "saved journal" },
      { sequence: 2, source: "lifecycle", kind: "phase", text: markerPresent ? "finalizing" : "executing" },
    ]);
    expect(await store.completeSuccess(receipt)).toBe("succeeded");
    expect((await attempt(receipt)).output_complete).toBe(markerPresent);
    expect((await attempt(receipt)).metadata.completion_digest).toBe(receipt.digest);
    expect(receipt.result.outputComplete).toBe(!markerPresent);
  });

  test("a real first UPDATE statement timeout rolls back; only persistence is retried", async () => {
    const receipt = await claim();
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [receipt.runId]);
    const original = store.queue.transaction.bind(store.queue);
    const transaction = vi.spyOn(store.queue, "transaction").mockImplementation((operation) =>
      original(async (client) => {
        await client.query("SET LOCAL statement_timeout='40ms'");
        return operation(client);
      }),
    );
    try {
      await expect(store.completeSuccess(receipt)).rejects.toMatchObject({ code: "57014" });
      expect((await store.getRun(receipt.runId))?.status).toBe("running");
      expect((await attempt(receipt)).metadata).not.toHaveProperty("completion_digest");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      transaction.mockRestore();
    }
    expect(await persistCompletion(store, receipt, { delayMs: 0 })).toBe("succeeded");
    expect((await store.getRun(receipt.runId))?.logs).toBe("successful logs");
  });

  test("failure closing the attempt rolls back the already-written run snapshot", async () => {
    const receipt = await claim();
    const finish = vi.spyOn(store.queue, "finishAttempt").mockRejectedValueOnce(new Error("transient connection reset"));
    await expect(store.completeSuccess(receipt)).rejects.toThrow("connection reset");
    expect(await store.readCompletion(receipt)).toBe("pending");
    expect((await store.getRun(receipt.runId))?.result).toBeNull();
    finish.mockRestore();
    expect(await persistCompletion(store, receipt, { delayMs: 0 })).toBe("succeeded");
  });

  test("an acknowledged server COMMIT with a lost client response resolves by exact readback", async () => {
    const receipt = await claim();
    const original = store.queue.transaction.bind(store.queue);
    const transaction = vi.spyOn(store.queue, "transaction").mockImplementationOnce(async (operation) => {
      await original(operation);
      throw Object.assign(new Error("Query read timeout"), { code: "ECONNRESET" });
    });
    const complete = vi.spyOn(store, "completeSuccess");
    expect(await persistCompletion(store, receipt, { delayMs: 0 })).toBe("succeeded");
    expect(complete).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect((await attempt(receipt)).metadata.completion_digest).toBe(receipt.digest);
  });

  test("bounded connection failures preserve success for restart without queueing execution", async () => {
    const receipt = await claim("restart-worker", 5);
    await store.markExecutionStarted(receipt.runId, receipt.workerId, receipt.attemptNumber);
    const transaction = vi.spyOn(store.queue, "transaction").mockRejectedValue(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
    await expect(persistCompletion(store, receipt, { maxAttempts: 3, delayMs: 0 })).rejects.toMatchObject({ attempts: 3, receipt });
    expect(transaction).toHaveBeenCalledTimes(3);
    transaction.mockRestore();
    await expire(receipt);
    const restarted = new AgentRunStore(config);
    try {
      expect(await restarted.recoverStaleRuns()).toBe(1);
      expect(await restarted.getRun(receipt.runId)).toMatchObject({ status: "completion_pending", locked_by: receipt.workerId, attempts: 1 });
      expect(await restarted.claimNext("unrelated-worker")).toBeUndefined();
      expect(await restarted.retryFailedRun(receipt.runId)).toBe("not-failed");
      expect(await restarted.readCompletion(receipt)).toBe("pending");
      expect(await persistCompletion(restarted, receipt, { delayMs: 0 })).toBe("succeeded");
      expect((await restarted.getRun(receipt.runId))?.logs).toBe(receipt.result.logs);
    } finally {
      await restarted.close();
    }
  });

  test.each(["executing", "finalizing"])("holds a legacy stale %s phase without a receipt", async (phase) => {
    const receipt = await claim("legacy-worker", 5);
    await pool.query(`UPDATE "${schema}"."agent_runs_attempts" SET phase=$1 WHERE run_id=$2`, [phase, receipt.runId]);
    await expire(receipt);
    expect(await store.recoverStaleRuns()).toBe(1);
    expect(await store.getRun(receipt.runId)).toMatchObject({ status: "completion_pending", locked_by: "legacy-worker" });
    expect((await attempt(receipt)).status).toBe("running");
    expect(await store.claimNext("new-worker")).toBeUndefined();
  });

  test("terminal lifecycle evidence prevents stale execution retry even without start metadata", async () => {
    const receipt = await claim("terminal-worker", 5);
    await store.queue.append(receipt.runId, receipt.attemptNumber, receipt.workerId, [
      { sequence: 1, source: "lifecycle", kind: "result", data: { exit_code: 0 } },
    ]);
    await expire(receipt);
    await store.recoverStaleRuns();
    expect((await store.getRun(receipt.runId))?.status).toBe("completion_pending");
    expect(await store.claimNext("new-worker")).toBeUndefined();
  });

  test("pre-execution workspace expiration retains prior retry recovery", async () => {
    const receipt = await claim("workspace-worker", 2);
    await expire(receipt);
    await store.recoverStaleRuns();
    expect((await store.getRun(receipt.runId))?.status).toBe("retry");
    expect((await attempt(receipt)).status).toBe("failed");
    const next = (await store.claimNext("replacement-worker"))!;
    expect(next.row.attempts).toBe(2);
  });

  test("start acknowledgement racing stale recovery refreshes the locked lease before execution", async () => {
    const receipt = await claim("start-race-worker", 5);
    await expire(receipt);
    let markerReady!: () => void;
    let allowCommit!: () => void;
    const ready = new Promise<void>((resolve) => { markerReady = resolve; });
    const commit = new Promise<void>((resolve) => { allowCommit = resolve; });
    const original = store.queue.transaction.bind(store.queue);
    vi.spyOn(store.queue, "transaction").mockImplementationOnce((operation) => original(async (client) => {
      const result = await operation(client);
      markerReady();
      await commit;
      return result;
    }));
    const starting = store.markExecutionStarted(receipt.runId, receipt.workerId, receipt.attemptNumber);
    await ready;
    const staleAfter = config.staleAfterMs;
    config.staleAfterMs = 1;
    // Even if the new heartbeat is already old by commit time, recovery's old
    // snapshot cannot undo the start marker which it could not see yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    let recoverySettled = false;
    const recovery = store.recoverStaleRuns().finally(() => { recoverySettled = true; });
    try {
      // Recovery reads the expired snapshot and blocks on the marker transaction's row lock.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(recoverySettled).toBe(false);
    } finally {
      allowCommit();
    }
    try {
      expect(await starting).toBe(true);
      expect(await recovery).toBe(0);
      expect((await store.getRun(receipt.runId))?.status).toBe("running");
      expect((await attempt(receipt)).metadata.execution_started).toBe(true);
    } finally {
      config.staleAfterMs = staleAfter;
    }
  });

  test("cancellation wins completion while preserving the successful result and exit code", async () => {
    const receipt = await claim();
    await store.requestCancellation(receipt.runId);
    expect(await store.markExecutionStarted(receipt.runId, receipt.workerId, receipt.attemptNumber)).toBe(false);
    expect(await store.completeSuccess(receipt)).toBe("cancelled");
    expect(await store.readCompletion(receipt)).toBe("cancelled");
    expect(await store.getRun(receipt.runId)).toMatchObject({ status: "cancelled", exit_code: 0, logs: receipt.result.logs, error: { message: "cancelled by user" } });
    expect((await attempt(receipt)).metadata.completion_digest).toBe(receipt.digest);
    expect(await store.retryFailedRun(receipt.runId)).toBe("not-failed");
  });

  test("cancellation racing completion has one terminal outcome and retains success output", async () => {
    const receipt = await claim();
    const [completed, cancelled] = await Promise.all([
      store.completeSuccess(receipt), store.requestCancellation(receipt.runId),
    ]);
    expect(["succeeded", "cancelled"]).toContain(completed);
    expect(await store.getRun(receipt.runId)).toMatchObject({ status: completed, exit_code: 0, logs: receipt.result.logs });
    expect((await attempt(receipt)).status).toBe(completed);
    if (completed === "succeeded") expect(cancelled.outcome).toBe("not-running");
    else expect(cancelled.outcome).toBe("requested");
    expect(await store.readCompletion(receipt)).toBe(completed);
  });

  test("held completion accepts a cancellation request and replays the saved success as cancelled", async () => {
    const receipt = await claim();
    await store.markExecutionStarted(receipt.runId, receipt.workerId, receipt.attemptNumber);
    await expire(receipt);
    await store.recoverStaleRuns();
    expect(await store.requestCancellation(receipt.runId)).toMatchObject({ outcome: "requested", lockedBy: receipt.workerId });
    expect((await store.getRun(receipt.runId))?.status).toBe("completion_pending");
    expect(await store.completeSuccess(receipt)).toBe("cancelled");
    expect((await store.getRun(receipt.runId))?.exit_code).toBe(0);
  });

  test("pending completions reserve their retained worktree and session from cleanup and reuse", async () => {
    await pool.query(
      `INSERT INTO ${table} (status,raw_webhook_data,prompt,uid,created_at,finished_at,priority,agent_provider,agent_mode,
        session_id,repo_path,worktree_path,branch_name)
       VALUES ('succeeded','{}','source','shared',NOW()-interval '1 minute',NOW(),0,'claude','exec',
        'held-session','/tmp/synthetic-repo','/tmp/synthetic-worktree','held-branch')`,
    );
    await pool.query(
      `INSERT INTO ${table} (status,raw_webhook_data,prompt,uid,created_at,priority,agent_provider,agent_mode,
        session_id,repo_path,worktree_path,locked_by,attempts)
       VALUES ('completion_pending','{}','held','shared',NOW(),0,'claude','exec',
        'held-session','/tmp/synthetic-repo','/tmp/synthetic-worktree','old-worker',1)`,
    );
    expect(await store.completedRunsOldestFirst()).toEqual([]);
    await pool.query(
      `INSERT INTO ${table} (status,raw_webhook_data,prompt,uid,created_at,priority,agent_provider,reuse_session)
       VALUES ('queued','{}','reuse request','shared',NOW(),0,'codex',true)`,
    );
    const claimed = (await store.claimNext("unrelated-worker", "codex"))!;
    expect(claimed.row.session_id).toBeNull();
    expect(claimed.row.reused_from_run_id).toBeNull();
    expect(claimed.resolved.provider).toBe("codex");
    expect(claimed.row.reuse_fallback_reason).toContain("no available successful run");
    await store.markFailed(claimed.row.id, "unrelated-worker", claimed.row, new Error("synthetic failure"), { exitCode: 1, logs: "" });
    await pool.query(`UPDATE ${table} SET session_id='held-session',agent_mode='exec' WHERE id=$1`, [claimed.row.id]);
    expect(await store.retryFailedRun(claimed.row.id)).toBe("queued");
    expect(await store.claimNext("retry-worker")).toBeUndefined();
  });

  test("stale attempt/worker cannot complete or heartbeat a later attempt using the same worker ID", async () => {
    const receipt = await claim("reused-worker-id");
    const old = (await store.getRun(receipt.runId))!;
    await store.markFailed(receipt.runId, receipt.workerId, old, new Error("agent failed"), { exitCode: 1, logs: "failure" });
    expect(await store.retryFailedRun(receipt.runId)).toBe("queued");
    const next = (await store.claimNext(receipt.workerId))!;
    expect(next.row.attempts).toBe(2);
    await expire(receipt);
    const heartbeat = (await store.getRun(receipt.runId))?.heartbeat_at;
    await store.heartbeat(receipt.runId, receipt.workerId, receipt.attemptNumber);
    expect((await store.getRun(receipt.runId))?.heartbeat_at).toEqual(heartbeat);
    expect(await store.completeSuccess(receipt)).toBe("stale");
    expect(await store.markExecutionStarted(receipt.runId, receipt.workerId, receipt.attemptNumber)).toBe(false);
    const wrongWorker = createCompletionReceipt(receipt.runId, 2, "wrong-worker", receipt.result);
    expect(await store.completeSuccess(wrongWorker)).toBe("stale");
    expect((await store.getRun(receipt.runId))?.status).toBe("running");
    expect((await store.getRun(receipt.runId))?.logs).toBe("failure");
  });

  test("terminal success evidence blocks manual retry and forged retry claims without changing records", async () => {
    const receipt = await claim();
    await store.queue.append(receipt.runId, receipt.attemptNumber, receipt.workerId, [
      { sequence: 1, source: "lifecycle", kind: "result", data: { exit_code: 0 } },
    ]);
    const row = (await store.getRun(receipt.runId))!;
    await store.markFailed(receipt.runId, receipt.workerId, row, new Error("legacy save failure"), { exitCode: 1, logs: "" });
    const snapshot = await store.getRun(receipt.runId);
    expect(await store.retryFailedRun(receipt.runId)).toBe("not-failed");
    await expect(store.queue.mutate({ issuer: "synthetic", subject: "test" }, "retry_job",
      { request_id: randomUUID(), job_id: receipt.runId })).rejects.toMatchObject({ code: "invalid_state" });
    expect(await store.getRun(receipt.runId)).toEqual(snapshot);
    await pool.query(`UPDATE ${table} SET status='retry' WHERE id=$1`, [receipt.runId]);
    expect(await store.claimNext("new-worker")).toBeUndefined();
    expect((await store.getRun(receipt.runId))?.attempts).toBe(1);
  });
});

function serviceConfig(url: string, databaseSchema: string): ServiceConfig {
  return {
    cwd: "/tmp", configPath: "/tmp/agentrunner_config.toml", databaseUrl: url, databaseUrlEnvVar: "TEST_DATABASE_URL",
    databaseSchema, databaseTable: "agent_runs", agentProvider: "both", defaultAgentProvider: "codex", agentMode: "exec",
    numWorkers: 1, pollFrequencyMs: 60_000, staleAfterMs: 1000, preflightRetries: 2, preflightRetryDelayMs: 0,
    host: "127.0.0.1", port: 0,
    git: { createWorktrees: "auto", remote: "origin", branchPrefix: "agentrunner", worktreeDir: ".worktrees", maxWorktrees: 25,
      cleanupBatchSize: 5, cleanupDeleteBranches: false, deleteDirtyWorktrees: false, setup: "auto", setupCommand: [] },
    codex: { bin: "codex", bypassApprovalsAndSandbox: true, extraArgs: [], appServerExtraArgs: [], config: [] },
    claude: { bin: "claude", extraArgs: [] },
  };
}
