import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { redactValue } from "./redact.js";
import type { ExecutionResult, ServiceConfig } from "./types.js";

export interface CompletionReceipt {
  readonly version: 1;
  readonly runId: number;
  readonly attemptNumber: number;
  readonly workerId: string;
  readonly completedAt: string;
  readonly result: ExecutionResult;
  readonly digest: string;
}

export type CompletionOutcome = "succeeded" | "cancelled" | "stale" | "pending";

export interface CompletionPersistenceStore {
  completeSuccess(receipt: CompletionReceipt): Promise<CompletionOutcome>;
  /** Must use a fresh query, including after an uncertain transaction commit. */
  readCompletion(receipt: CompletionReceipt): Promise<CompletionOutcome>;
}

export interface CompletionRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void;
}

export class CompletionPersistenceError extends Error {
  constructor(
    readonly receipt: CompletionReceipt,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`Unable to persist successful run ${receipt.runId} attempt ${receipt.attemptNumber}; completion retained`, {
      cause,
    });
    this.name = "CompletionPersistenceError";
  }
}

/** This retry boundary has no access to execution or queue retry APIs. */
export async function persistCompletion(
  store: CompletionPersistenceStore,
  receipt: CompletionReceipt,
  options: CompletionRetryOptions = {},
): Promise<CompletionOutcome> {
  validateReceipt(receipt);
  deepFreeze(receipt);
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 100;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("Completion retries require a positive maxAttempts and nonnegative delayMs");
  }
  let last: unknown = new Error("Completion remains pending");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const outcome = await store.completeSuccess(receipt);
      if (outcome !== "pending") return outcome;
      last = new Error("Completion remains pending");
    } catch (error) {
      last = error;
    }
    // A lost COMMIT response can mean the transaction committed. Check the attempt
    // and digest on a fresh connection before retrying the identical operation.
    try {
      const outcome = await store.readCompletion(receipt);
      if (outcome !== "pending") return outcome;
    } catch (error) {
      last = error;
    }
    if (attempt < maxAttempts) {
      options.onRetry?.(last, attempt, maxAttempts);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw new CompletionPersistenceError(receipt, maxAttempts, last);
}

export function createCompletionReceipt(
  runId: number,
  attemptNumber: number,
  workerId: string,
  result: ExecutionResult,
  completedAt = new Date().toISOString(),
): CompletionReceipt {
  // Clone before hashing: callers cannot change the payload between SQL retries.
  const snapshot = JSON.parse(JSON.stringify(redactValue(result))) as ExecutionResult;
  const body = { version: 1 as const, runId, attemptNumber, workerId, completedAt, result: snapshot };
  const receipt = { ...body, digest: digestBody(body) };
  validateReceipt(receipt);
  return deepFreeze(receipt);
}

/** Credentials and transport settings do not change a queue's receipt namespace. */
export function defaultSpoolDirectory(config: ServiceConfig): string {
  const database = new URL(config.databaseUrl);
  const identity = JSON.stringify([
    database.hostname.toLowerCase(),
    database.port || "5432",
    database.pathname,
    config.databaseSchema,
    config.databaseTable,
  ]);
  return path.join(config.cwd, ".agentrunner-completions", createHash("sha256").update(identity).digest("hex"));
}

const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const RECEIPT_NAME = /^\d+-\d+-[a-f0-9]{64}\.json$/;
const CONCURRENT_WRITE_RECHECKS = 50;
const CONCURRENT_WRITE_DELAY_MS = 20;

/** Durable, private spool. Invalid/partial evidence fails closed instead of being discarded. */
export class CompletionSpool {
  readonly directory: string;
  constructor(directory: string, private readonly maxBytes = MAX_RECEIPT_BYTES) {
    this.directory = path.resolve(directory);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid completion receipt size limit");
  }

  async put(receipt: CompletionReceipt): Promise<void> {
    validateReceipt(receipt);
    const serialized = JSON.stringify(receipt);
    if (Buffer.byteLength(serialized) > this.maxBytes) throw new Error("Completion receipt exceeds spool size limit");
    await this.ensureDirectory();
    const name = receiptName(receipt);
    const destination = path.join(this.directory, name);
    // One temporary file per immutable receipt bounds residue across disk-failure
    // retries. A partial file is retained for inspection, never overwritten.
    const temporary = path.join(this.directory, `.${name}.tmp`);
    if (await this.existingReceipt(name, serialized)) {
      await this.waitForConcurrentWriter(name, temporary, serialized);
      return;
    }
    let file;
    try {
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      await this.waitForConcurrentWriter(name, temporary, serialized);
      return;
    }
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // link is atomic and never replaces an existing receipt from another writer.
      await link(temporary, destination);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (!(await this.existingReceipt(name, serialized))) throw new Error("Completion receipt disappeared during write");
    }
    await unlink(temporary);
    await this.syncDirectory();
  }

  private async existingReceipt(name: string, serialized: string): Promise<boolean> {
    try {
      const existing = await this.read(name);
      if (JSON.stringify(existing) !== serialized) throw new Error("Conflicting completion receipt already exists");
      return true;
    } catch (error) {
      if (isCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async waitForConcurrentWriter(name: string, temporary: string, serialized: string): Promise<void> {
    for (let check = 0; check <= CONCURRENT_WRITE_RECHECKS; check++) {
      const complete = await this.existingReceipt(name, serialized);
      let temporaryExists = true;
      try {
        await lstat(temporary);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
        temporaryExists = false;
      }
      if (complete && !temporaryExists) {
        await this.syncDirectory();
        return;
      }
      if (check < CONCURRENT_WRITE_RECHECKS) {
        await new Promise(resolve => setTimeout(resolve, CONCURRENT_WRITE_DELAY_MS));
      }
    }
    throw new Error("Incomplete completion receipt temporary file; manual inspection required");
  }

  async list(): Promise<CompletionReceipt[]> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).sort();
    const receipts: CompletionReceipt[] = [];
    for (const name of names) {
      if (!RECEIPT_NAME.test(name)) {
        throw new Error("Unexpected or incomplete completion spool file; manual inspection required");
      }
      receipts.push(await this.read(name));
    }
    return receipts;
  }

  async remove(receipt: CompletionReceipt): Promise<void> {
    validateReceipt(receipt);
    await this.ensureDirectory();
    try {
      await unlink(path.join(this.directory, receiptName(receipt)));
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    await this.syncDirectory();
  }

  private async read(name: string): Promise<CompletionReceipt> {
    const file = await open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error("Completion receipt must be a private file owned by the service user");
      }
      if (stat.size > this.maxBytes) throw new Error("Completion receipt exceeds spool size limit");
      const receipt: unknown = JSON.parse(await file.readFile("utf8"));
      validateReceipt(receipt);
      if (receiptName(receipt) !== name) throw new Error("Completion receipt filename does not match its identity");
      return deepFreeze(receipt);
    } finally {
      await file.close();
    }
  }

  private async ensureDirectory(): Promise<void> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Completion spool must be a private directory owned by the service user");
    }
    if (created) {
      // fsync each new directory and its parent: persisting only the receipt's
      // immediate directory does not make a freshly created hierarchy durable.
      const parent = path.dirname(created);
      let directory = this.directory;
      for (;;) {
        await this.syncDirectoryAt(directory);
        if (directory === parent) break;
        directory = path.dirname(directory);
      }
    }
  }

  private async syncDirectory(): Promise<void> {
    await this.syncDirectoryAt(this.directory);
  }

  private async syncDirectoryAt(directoryPath: string): Promise<void> {
    const directory = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function receiptName(receipt: CompletionReceipt): string {
  return `${receipt.runId}-${receipt.attemptNumber}-${receipt.digest}.json`;
}

function digestBody(body: Omit<CompletionReceipt, "digest">): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function validateReceipt(value: unknown): asserts value is CompletionReceipt {
  if (!value || typeof value !== "object") throw new Error("Invalid completion receipt");
  const receipt = value as CompletionReceipt;
  if (
    receipt.version !== 1 ||
    !Number.isSafeInteger(receipt.runId) || receipt.runId < 1 ||
    !Number.isSafeInteger(receipt.attemptNumber) || receipt.attemptNumber < 1 ||
    typeof receipt.workerId !== "string" || !receipt.workerId || receipt.workerId.length > 512 ||
    typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt)) ||
    !receipt.result || receipt.result.exitCode !== 0 || typeof receipt.result.logs !== "string" ||
    (receipt.result.journalEndSequence !== undefined &&
      (!Number.isSafeInteger(receipt.result.journalEndSequence) || receipt.result.journalEndSequence < 1)) ||
    typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest)
  ) throw new Error("Invalid completion receipt");
  const body = {
    version: receipt.version,
    runId: receipt.runId,
    attemptNumber: receipt.attemptNumber,
    workerId: receipt.workerId,
    completedAt: receipt.completedAt,
    result: receipt.result,
  };
  if (digestBody(body) !== receipt.digest) throw new Error("Completion receipt digest mismatch");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
