import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CompletionPersistenceError,
  CompletionSpool,
  createCompletionReceipt,
  defaultSpoolDirectory,
  persistCompletion,
  type CompletionPersistenceStore,
} from "./completion.js";
import type { ExecutionResult, ServiceConfig } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentrunner-completion-test-"));
  directories.push(directory);
  return directory;
}

function receipt(result: ExecutionResult = { exitCode: 0, logs: "all output", lastMessage: "done", result: { done: true } }) {
  return createCompletionReceipt(42, 3, "worker-original", result, "2026-10-14T21:24:00.000Z");
}

describe("completion-only retry", () => {
  test.each([
    Object.assign(new Error("Query read timeout"), { code: "57014" }),
    Object.assign(new Error("connection lost"), { code: "ECONNRESET" }),
  ])("retries persistence after %s with the identical immutable result", async (error) => {
    const saved = receipt();
    const store: CompletionPersistenceStore = {
      completeSuccess: vi.fn().mockRejectedValueOnce(error).mockResolvedValue("succeeded"),
      readCompletion: vi.fn().mockResolvedValue("pending"),
    };
    const retry = vi.fn();
    expect(await persistCompletion(store, saved, { delayMs: 0, onRetry: retry })).toBe("succeeded");
    expect(store.completeSuccess).toHaveBeenCalledTimes(2);
    expect(store.completeSuccess).toHaveBeenNthCalledWith(1, saved);
    expect(store.completeSuccess).toHaveBeenNthCalledWith(2, saved);
    expect(store.readCompletion).toHaveBeenCalledWith(saved);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(saved.result).toEqual({ exitCode: 0, logs: "all output", lastMessage: "done", result: { done: true } });
  });

  test("fresh readback resolves a lost COMMIT response without a second update", async () => {
    const store: CompletionPersistenceStore = {
      completeSuccess: vi.fn().mockRejectedValue(new Error("COMMIT response disconnected")),
      readCompletion: vi.fn().mockResolvedValue("succeeded"),
    };
    expect(await persistCompletion(store, receipt(), { delayMs: 0 })).toBe("succeeded");
    expect(store.completeSuccess).toHaveBeenCalledTimes(1);
    expect(store.readCompletion).toHaveBeenCalledTimes(1);
  });

  test("uncertain commit plus unavailable readback can retry the same idempotent completion", async () => {
    const store: CompletionPersistenceStore = {
      completeSuccess: vi.fn().mockRejectedValueOnce(new Error("COMMIT response lost")).mockResolvedValue("succeeded"),
      readCompletion: vi.fn().mockRejectedValue(new Error("connection unavailable")),
    };
    expect(await persistCompletion(store, receipt(), { delayMs: 0 })).toBe("succeeded");
    expect(store.completeSuccess).toHaveBeenCalledTimes(2);
  });

  test.each(["cancelled", "stale"] as const)("respects %s without another completion write", async (outcome) => {
    const store: CompletionPersistenceStore = {
      completeSuccess: vi.fn().mockRejectedValue(new Error("uncertain write")),
      readCompletion: vi.fn().mockResolvedValue(outcome),
    };
    expect(await persistCompletion(store, receipt(), { delayMs: 0 })).toBe(outcome);
    expect(store.completeSuccess).toHaveBeenCalledTimes(1);
  });

  test("bounded exhaustion keeps the successful receipt and does not expose execution retry or failure APIs", async () => {
    const saved = receipt();
    const cause = new Error("database unavailable");
    const store = {
      completeSuccess: vi.fn().mockRejectedValue(cause),
      readCompletion: vi.fn().mockRejectedValue(cause),
      runAgent: vi.fn(),
      markFailed: vi.fn(),
      retryFailedRun: vi.fn(),
    };
    const operation = persistCompletion(store, saved, { maxAttempts: 3, delayMs: 0 });
    await expect(operation).rejects.toMatchObject({ receipt: saved, attempts: 3, cause });
    await expect(operation).rejects.toBeInstanceOf(CompletionPersistenceError);
    expect(store.completeSuccess).toHaveBeenCalledTimes(3);
    expect(store.readCompletion).toHaveBeenCalledTimes(3);
    expect(store.runAgent).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(store.retryFailedRun).not.toHaveBeenCalled();
    expect(saved.result.exitCode).toBe(0);
  });

  test("zero retries is one attempt, and invalid bounds cannot loop forever", async () => {
    const store: CompletionPersistenceStore = {
      completeSuccess: vi.fn().mockResolvedValue("pending"),
      readCompletion: vi.fn().mockResolvedValue("pending"),
    };
    await expect(persistCompletion(store, receipt(), { maxAttempts: 1, delayMs: 0 })).rejects.toMatchObject({ attempts: 1 });
    expect(store.completeSuccess).toHaveBeenCalledTimes(1);
    await expect(persistCompletion(store, receipt(), { maxAttempts: 0 })).rejects.toThrow("positive maxAttempts");
    await expect(persistCompletion(store, receipt(), { delayMs: -1 })).rejects.toThrow("nonnegative delayMs");
  });
});

describe("durable completion spool", () => {
  test("clones and deeply freezes redacted output before hashing or retrying", () => {
    const original = { exitCode: 0, logs: "PASSWORD=secret-value", result: { nested: { password: "secret" } } };
    const saved = receipt(original);
    original.logs = "changed";
    original.result.nested.password = "changed";
    expect(saved.result.logs).toBe("PASSWORD=[REDACTED]");
    expect(saved.result.result).toEqual({ nested: { password: "[REDACTED]" } });
    expect(Object.isFrozen(saved.result)).toBe(true);
    expect(Object.isFrozen((saved.result.result as { nested: unknown }).nested)).toBe(true);
    expect(() => { saved.result.logs = "cannot mutate"; }).toThrow();
  });

  test("rejects non-success or invalid attempt identity receipts", () => {
    expect(() => receipt({ exitCode: 1, logs: "failed" })).toThrow("Invalid completion receipt");
    expect(() => createCompletionReceipt(42, 0, "worker", { exitCode: 0, logs: "" })).toThrow();
    expect(() => createCompletionReceipt(-1, 1, "worker", { exitCode: 0, logs: "" })).toThrow();
  });

  test("validates the optional journal end marker before persistence", () => {
    expect(receipt({ exitCode: 0, logs: "", journalEndSequence: 3 }).result.journalEndSequence).toBe(3);
    for (const journalEndSequence of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => receipt({ exitCode: 0, logs: "", journalEndSequence })).toThrow("Invalid completion receipt");
    }
  });

  test("persists full output with private permissions and reconstructs completion after restart", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "spool");
    const firstProcess = new CompletionSpool(directory);
    const saved = receipt({
      exitCode: 0,
      logs: "x".repeat(100_000),
      lastMessage: "full provider result",
      conversation: [{ nested: { full: true } }],
      result: { nested: "complete" },
      workspace: { cwd: "/repo", worktreePath: "/repo/worktree" },
      outputComplete: false,
    });
    await firstProcess.put(saved);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, files[0]!))).mode & 0o777).toBe(0o600);

    const restarted = new CompletionSpool(directory);
    const [restored] = await restarted.list();
    expect(restored).toEqual(saved);
    const store: CompletionPersistenceStore = {
      completeSuccess: vi.fn().mockResolvedValue("succeeded"),
      readCompletion: vi.fn(),
    };
    expect(await persistCompletion(store, restored!, { delayMs: 0 })).toBe("succeeded");
    await restarted.remove(restored!);
    expect(await restarted.list()).toEqual([]);
  });

  test("retains receipt through DB exhaustion so restart replays persistence only", async () => {
    const directory = path.join(await temporaryDirectory(), "spool");
    const saved = receipt();
    await new CompletionSpool(directory).put(saved);
    const store: CompletionPersistenceStore = {
      completeSuccess: vi.fn().mockRejectedValue(new Error("Query read timeout")),
      readCompletion: vi.fn().mockResolvedValue("pending"),
    };
    await expect(persistCompletion(store, saved, { delayMs: 0 })).rejects.toBeInstanceOf(CompletionPersistenceError);
    const [restored] = await new CompletionSpool(directory).list();
    expect(restored).toEqual(saved);
    store.completeSuccess = vi.fn().mockResolvedValue("succeeded");
    expect(await persistCompletion(store, restored!, { delayMs: 0 })).toBe("succeeded");
    expect(store.completeSuccess).toHaveBeenCalledWith(saved);
  });

  test("concurrent duplicate receipt writers do not overwrite or lose output", async () => {
    const directory = path.join(await temporaryDirectory(), "spool");
    const saved = receipt();
    await Promise.all([new CompletionSpool(directory).put(saved), new CompletionSpool(directory).put(saved)]);
    expect(await new CompletionSpool(directory).list()).toEqual([saved]);
  });

  test("repeated writes encountering partial evidence cannot allocate more temporary files", async () => {
    const directory = path.join(await temporaryDirectory(), "spool");
    const spool = new CompletionSpool(directory);
    await spool.list();
    const saved = receipt();
    const temporary = `.${saved.runId}-${saved.attemptNumber}-${saved.digest}.json.tmp`;
    await writeFile(path.join(directory, temporary), "partial result evidence", { mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(spool.put(saved)).rejects.toThrow("manual inspection required");
    }
    expect(await readdir(directory)).toEqual([temporary]);
    expect(await readFile(path.join(directory, temporary), "utf8")).toBe("partial result evidence");
    await expect(spool.list()).rejects.toThrow("incomplete");
  });

  test("an existing durable receipt does not silently discard conflicting temporary evidence", async () => {
    const directory = path.join(await temporaryDirectory(), "spool");
    const spool = new CompletionSpool(directory);
    const saved = receipt();
    await spool.put(saved);
    const temporary = `.${saved.runId}-${saved.attemptNumber}-${saved.digest}.json.tmp`;
    await writeFile(path.join(directory, temporary), "partial residue", { mode: 0o600 });
    await expect(spool.put(saved)).rejects.toThrow("manual inspection required");
    expect(await readdir(directory)).toHaveLength(2);
    expect(await readFile(path.join(directory, temporary), "utf8")).toBe("partial residue");
  });

  test("invalid, partial or oversized evidence fails closed and remains on disk", async () => {
    const directory = path.join(await temporaryDirectory(), "spool");
    const spool = new CompletionSpool(directory, 4096);
    const saved = receipt();
    await spool.put(saved);
    const [name] = await readdir(directory);
    const filename = path.join(directory, name!);
    const tampered = JSON.parse(await readFile(filename, "utf8"));
    tampered.result.logs = "altered result";
    await writeFile(filename, JSON.stringify(tampered));
    await expect(spool.list()).rejects.toThrow("digest mismatch");
    await writeFile(filename, "{" );
    await expect(spool.list()).rejects.toThrow();
    await writeFile(filename, "x".repeat(4097));
    await expect(spool.list()).rejects.toThrow("size limit");
    await rm(filename);
    await writeFile(path.join(directory, ".unfinished.tmp"), "partial successful result", { mode: 0o600 });
    await expect(spool.list()).rejects.toThrow("incomplete");
    expect(await readFile(path.join(directory, ".unfinished.tmp"), "utf8")).toContain("successful result");
  });

  test("does not write oversized output or accept public spool directories", async () => {
    const directory = path.join(await temporaryDirectory(), "spool");
    await expect(new CompletionSpool(directory, 10).put(receipt())).rejects.toThrow("size limit");
    const spool = new CompletionSpool(directory);
    await spool.list();
    await chmod(directory, 0o755);
    await expect(spool.list()).rejects.toThrow("private directory");
  });

  test("does not follow symlink receipt files or a symlink spool directory", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "spool");
    const spool = new CompletionSpool(directory);
    await spool.put(receipt());
    const [name] = await readdir(directory);
    const filename = path.join(directory, name!);
    await rm(filename);
    const outside = path.join(root, "outside.json");
    await writeFile(outside, JSON.stringify(receipt()), { mode: 0o600 });
    await symlink(outside, filename);
    await expect(spool.list()).rejects.toThrow();
    const symlinkDirectory = path.join(root, "linked-spool");
    await symlink(directory, symlinkDirectory);
    await expect(new CompletionSpool(symlinkDirectory).list()).rejects.toThrow("private directory");
  });

  test("queue namespace is stable across credentials and separates databases and tables", () => {
    const config = { cwd: "/repo", databaseUrl: "postgres://user:secret@DB.example:5432/queue?sslmode=require", databaseSchema: "public", databaseTable: "agent_runs" } as ServiceConfig;
    const first = defaultSpoolDirectory(config);
    expect(first).toBe(defaultSpoolDirectory({ ...config, databaseUrl: "postgres://newuser:newsecret@db.example/queue" }));
    expect(first).not.toBe(defaultSpoolDirectory({ ...config, databaseTable: "other_runs" }));
    expect(first).not.toBe(defaultSpoolDirectory({ ...config, databaseUrl: "postgres://user:secret@DB.example/another_database" }));
    expect(first).not.toContain("secret");
  });
});
