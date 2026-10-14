import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CompletionSpool, createCompletionReceipt, defaultSpoolDirectory, type CompletionReceipt } from "./completion.js";
import { AgentRunnerService } from "./service.js";
import { AttemptRecorder } from "./recorder.js";
import type { AgentRunStore } from "./store.js";
import type { ClaimedRun, ExecutionResult, ServiceConfig } from "./types.js";

const provider = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock("./executors/index.js", () => ({ runAgent: provider.runAgent }));

interface ServiceHarness {
  store: AgentRunStore;
  stopping: boolean;
  workers: Promise<void>[];
  pendingCompletions: Map<string, unknown>;
  workerLoop(worker: string, provider: "codex"): Promise<void>;
  recoverCompletions(): Promise<void>;
  flushCompletions(): Promise<void>;
  retainSuccessfulCompletion(claimed: ClaimedRun, worker: string, result: ExecutionResult): Promise<void>;
  prepareFreshWorkspace: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
}

const roots: string[] = [];
const services: AgentRunnerService[] = [];
beforeEach(() => {
  provider.runAgent.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(cwd?: string) {
  cwd ??= await fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-service-completion-"));
  if (!roots.includes(cwd)) roots.push(cwd);
  const config = {
    cwd, configPath: path.join(cwd, "config.toml"), databaseUrl: "postgres://unused/isolated-test-only",
    databaseUrlEnvVar: "UNUSED", databaseSchema: "public", databaseTable: "jobs",
    agentProvider: "codex", defaultAgentProvider: "codex", agentMode: "exec", numWorkers: 1,
    pollFrequencyMs: 60_000, staleAfterMs: 900_000, preflightRetries: 0, preflightRetryDelayMs: 0,
    host: "127.0.0.1", port: 0, git: {}, codex: {}, claude: {},
  } as ServiceConfig;
  const service = new AgentRunnerService(config);
  services.push(service);
  const harness = service as unknown as ServiceHarness;
  // Close the real, never-connected pool and replace every persistence boundary.
  // Tests cannot reach any database or an unmocked provider.
  await harness.store.close();
  const claimed = {
    row: { id: 1, attempts: 1, num_retries: 3, prompt: "synthetic", status: "running", locked_by: "worker" },
    resolved: { provider: "codex", mode: "exec" }, requested: { provider: "codex", mode: "exec" },
  } as ClaimedRun;
  const store = {
    queue: { append: vi.fn().mockResolvedValue(undefined), validate: vi.fn().mockResolvedValue(undefined) },
    claimNext: vi.fn().mockResolvedValue(claimed),
    markExecutionStarted: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(false),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    countQueued: vi.fn().mockResolvedValue(0),
    completeSuccess: vi.fn().mockResolvedValue("succeeded"),
    readCompletion: vi.fn().mockResolvedValue("pending"),
    markSucceeded: vi.fn(), markFailed: vi.fn().mockResolvedValue(true), markCancelled: vi.fn(),
    recoverStaleRuns: vi.fn().mockResolvedValue(0), close: vi.fn().mockResolvedValue(undefined),
  };
  harness.store = store as unknown as AgentRunStore;
  harness.prepareFreshWorkspace = vi.fn().mockResolvedValue({ cwd, setupLogs: "setup output" });
  const result: ExecutionResult = {
    exitCode: 0, logs: "provider output", lastMessage: "full final answer", sessionId: "synthetic-session",
    conversation: [{ type: "turn.completed" }], result: { external_effect_completed: true },
  };
  provider.runAgent.mockImplementation(async () => {
    harness.stopping = true;
    return { ...result };
  });
  return { service, harness, store, config, cwd, result };
}

describe("successful execution completion boundary", () => {
  test.each([
    Object.assign(new Error("Query read timeout"), { code: "57014" }),
    Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  ])("persists success after %s without repeating the provider or discarding output", async fault => {
    const { harness, store, config } = await fixture();
    store.completeSuccess.mockRejectedValueOnce(fault).mockResolvedValue("succeeded");
    await harness.workerLoop("worker", "codex");
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
    expect(store.markExecutionStarted).toHaveBeenCalledBefore(provider.runAgent);
    expect(store.completeSuccess).toHaveBeenCalledTimes(2);
    const first = store.completeSuccess.mock.calls[0]![0] as CompletionReceipt;
    expect(store.completeSuccess.mock.calls[1]![0]).toBe(first);
    expect(first.result).toMatchObject({ exitCode: 0, logs: "setup output\nprovider output", lastMessage: "full final answer", result: { external_effect_completed: true } });
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(store.markSucceeded).not.toHaveBeenCalled();
    expect(await new CompletionSpool(defaultSpoolDirectory(config)).list()).toEqual([]);
  });

  test("lost COMMIT acknowledgement reads the applied receipt without repeating execution or update", async () => {
    const { harness, store } = await fixture();
    store.completeSuccess.mockRejectedValue(new Error("COMMIT connection lost"));
    store.readCompletion.mockResolvedValue("succeeded");
    await harness.workerLoop("worker", "codex");
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
    expect(store.completeSuccess).toHaveBeenCalledTimes(1);
    expect(store.readCompletion).toHaveBeenCalledTimes(1);
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(harness.pendingCompletions.size).toBe(0);
  });

  test("exhaustion retains full success, pauses claims and recovers persistence alone after restart", async () => {
    const first = await fixture();
    first.store.completeSuccess.mockRejectedValue(new Error("database unavailable"));
    await first.harness.workerLoop("worker", "codex");
    expect(first.store.completeSuccess).toHaveBeenCalledTimes(3);
    expect(first.store.readCompletion).toHaveBeenCalledTimes(3);
    expect(first.store.markFailed).not.toHaveBeenCalled();
    expect(first.harness.pendingCompletions.size).toBe(1);
    expect(first.service.stats().availableWorkers).toBe(0);
    const [receipt] = await new CompletionSpool(defaultSpoolDirectory(first.config)).list();
    expect(receipt?.result).toMatchObject({ exitCode: 0, lastMessage: "full final answer", result: { external_effect_completed: true } });

    first.harness.stopping = false;
    first.harness.sleep = vi.fn(async () => { first.harness.stopping = true; });
    await first.harness.workerLoop("worker", "codex");
    expect(first.store.claimNext).toHaveBeenCalledTimes(1);
    expect(provider.runAgent).toHaveBeenCalledTimes(1);

    const restarted = await fixture(first.cwd);
    await restarted.harness.recoverCompletions();
    expect(restarted.store.completeSuccess).toHaveBeenCalledWith(receipt);
    expect(restarted.store.claimNext).not.toHaveBeenCalled();
    expect(restarted.store.markFailed).not.toHaveBeenCalled();
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
    expect(await new CompletionSpool(defaultSpoolDirectory(first.config)).list()).toEqual([]);
  });

  test("unresolved restart receipt blocks public startup before stale recovery or any claim", async () => {
    const first = await fixture();
    first.store.completeSuccess.mockRejectedValue(new Error("database unavailable"));
    await first.harness.workerLoop("worker", "codex");
    const restarted = await fixture(first.cwd);
    restarted.store.completeSuccess.mockRejectedValue(new Error("still unavailable"));
    await expect(restarted.service.start()).rejects.toThrow("prevent worker startup");
    expect(restarted.store.recoverStaleRuns).not.toHaveBeenCalled();
    expect(restarted.store.claimNext).not.toHaveBeenCalled();
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
  });

  test("output-recorder failure after successful execution preserves exit zero and full result", async () => {
    const { harness, store } = await fixture();
    store.queue.append.mockRejectedValue(new Error("journal unavailable"));
    await harness.workerLoop("worker", "codex");
    const receipt = store.completeSuccess.mock.calls[0]![0] as CompletionReceipt;
    expect(receipt.result).toMatchObject({ exitCode: 0, outputComplete: false, lastMessage: "full final answer" });
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
  });

  test.each(["cancelled", "stale"])("%s completion does not rerun or overwrite through generic failure", async outcome => {
    const { harness, store, config } = await fixture();
    store.completeSuccess.mockResolvedValue(outcome);
    await harness.workerLoop("worker", "codex");
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
    expect(store.markFailed).not.toHaveBeenCalled();
    const receipts = await new CompletionSpool(defaultSpoolDirectory(config)).list();
    expect(receipts.length).toBe(outcome === "stale" ? 1 : 0);
    if (outcome === "stale") expect(receipts[0]?.result.exitCode).toBe(0);
  });

  test("unacknowledged execution-start ownership cannot invoke a provider", async () => {
    const { harness, store } = await fixture();
    store.markExecutionStarted.mockImplementation(async () => {
      harness.stopping = true;
      return false;
    });
    await harness.workerLoop("worker", "codex");
    expect(provider.runAgent).not.toHaveBeenCalled();
    expect(store.completeSuccess).not.toHaveBeenCalled();
  });

  test("a second worker durably spools success while the first worker's completion SQL is blocked", async () => {
    const { harness, store, config } = await fixture();
    let entered!: () => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    store.completeSuccess.mockImplementation(async (receipt: CompletionReceipt) => {
      if (receipt.runId === 1) { entered(); await blocked; }
      return "succeeded";
    });
    const claimed = (id: number) => ({ row: { id, attempts: 1 } } as ClaimedRun);
    const first = harness.retainSuccessfulCompletion(claimed(1), "worker-a", { exitCode: 0, logs: "full A" });
    const firstFlush = first.then(() => harness.flushCompletions());
    await firstEntered;
    const second = harness.retainSuccessfulCompletion(claimed(2), "worker-b", { exitCode: 0, logs: "full B" });
    try {
      await expect.poll(async () => {
        // A temporary atomic-write file can exist while this read is in progress.
        try { return (await new CompletionSpool(defaultSpoolDirectory(config)).list()).map(receipt => receipt.runId); }
        catch { return []; }
      }, { timeout: 1500 }).toContain(2);
      expect(store.completeSuccess.mock.calls.map(call => (call[0] as CompletionReceipt).runId)).toEqual([1]);
      expect(provider.runAgent).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first, firstFlush, second]);
      await harness.flushCompletions();
    }
  });

  test("completion polling cannot finalize a locally active journal drain", async () => {
    const { harness, store, config } = await fixture();
    let entered!: () => void;
    const draining = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(AttemptRecorder.prototype, "finish").mockImplementationOnce(async () => {
      entered();
      await drained;
      return true;
    });
    const worker = harness.workerLoop("worker", "codex");
    await draining;
    try {
      expect(await new CompletionSpool(defaultSpoolDirectory(config)).list()).toHaveLength(1);
      await harness.flushCompletions();
      expect(store.completeSuccess).not.toHaveBeenCalled();
    } finally {
      release();
      await worker;
    }
    expect(store.completeSuccess).toHaveBeenCalledTimes(1);
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  test("conflicting durable receipts for one attempt fail recovery closed without selecting a winner", async () => {
    const { harness, store, config } = await fixture();
    const spool = new CompletionSpool(defaultSpoolDirectory(config));
    const first = createCompletionReceipt(1, 1, "worker", { exitCode: 0, logs: "first result" });
    const second = createCompletionReceipt(1, 1, "worker", { exitCode: 0, logs: "different result" });
    await spool.put(first);
    await spool.put(second);
    await expect(harness.recoverCompletions()).rejects.toThrow(/conflict/i);
    expect(store.completeSuccess).not.toHaveBeenCalled();
    expect(store.claimNext).not.toHaveBeenCalled();
    expect(provider.runAgent).not.toHaveBeenCalled();
    expect(await spool.list()).toHaveLength(2);
  });

  test("shutdown after a provider returns success still persists that success before closing storage", async () => {
    const { service, harness, store } = await fixture();
    let entered!: () => void;
    const executing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const terminal = new Promise<void>(resolve => { release = resolve; });
    provider.runAgent.mockImplementation(async () => {
      entered();
      await terminal;
      return { exitCode: 0, logs: "external work already completed", result: { done: true } };
    });
    const worker = harness.workerLoop("worker", "codex");
    harness.workers.push(worker);
    await executing;
    const shutdown = service.stop();
    expect(provider.runAgent.mock.calls[0]![0].signal.aborted).toBe(true);
    release();
    await shutdown;
    expect(store.completeSuccess).toHaveBeenCalledTimes(1);
    expect(store.completeSuccess.mock.calls[0]![0].result).toMatchObject({ exitCode: 0, result: { done: true } });
    expect(store.completeSuccess).toHaveBeenCalledBefore(store.close);
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
  });

  test("a disk persistence failure retains success in memory and only retries spooling and completion", async () => {
    const { harness, store, config } = await fixture();
    const put = vi.spyOn(CompletionSpool.prototype, "put").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    await harness.workerLoop("worker", "codex");
    expect(harness.pendingCompletions.size).toBe(1);
    expect(store.completeSuccess).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
    put.mockRestore();
    await harness.flushCompletions();
    expect(store.completeSuccess.mock.calls[0]![0].result).toMatchObject({ exitCode: 0, lastMessage: "full final answer" });
    expect(harness.pendingCompletions.size).toBe(0);
    expect(provider.runAgent).toHaveBeenCalledTimes(1);
    expect(await new CompletionSpool(defaultSpoolDirectory(config)).list()).toEqual([]);
  });
});
