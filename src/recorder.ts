import { redactValue } from "./redact.js";
import type { QueueApi, JournalEvent } from "./queue-api.js";
import type { ExecutionEvent, ExecutionObserver } from "./types.js";

const FLUSH_BYTES = 64 * 1024;
const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/** One writer per claimed attempt, with stable sequence numbers for ambiguous DB retries. */
export class AttemptRecorder {
  private pending: JournalEvent[] = [];
  private sequence = 0;
  private bytes = 0;
  private queuedBytes = 0;
  private truncated = false;
  private failure?: Error;
  private writing?: Promise<void>;
  private timer: NodeJS.Timeout;
  constructor(
    private queue: Pick<QueueApi, "append">,
    private id: number,
    private attempt: number,
    private worker: string,
    private abort: (error: Error) => void,
    private maxBytes = 32 * 1024 * 1024,
  ) {
    this.timer = setInterval(() => void this.flush().catch(() => undefined), 1000);
    this.timer.unref();
  }
  observe: ExecutionObserver = (event) => {
    if (this.failure) return;
    if (event.text === "[oversized output line omitted]" && !this.truncated) {
      this.truncated = true;
      this.enqueue({
        source: "lifecycle",
        kind: "truncated",
        text: "Oversized output line omitted",
      });
    }
    let safe = redactValue(event);
    if (Buffer.byteLength(JSON.stringify(safe)) > 65536) {
      if (!this.truncated) {
        this.truncated = true;
        this.enqueue({
          source: "lifecycle",
          kind: "truncated",
          text: "Oversized output event truncated",
        });
      }
      safe = {
        ...safe,
        text: safe.text?.slice(0, 8192),
        data: {
          truncated: true,
          preview: JSON.stringify(safe.data ?? null).slice(0, 8192),
        },
      };
    }
    const size = Buffer.byteLength(JSON.stringify(safe));
    const output = event.source !== "lifecycle";
    if (output && this.bytes + size > this.maxBytes) {
      if (!this.truncated) {
        this.truncated = true;
        this.enqueue({
          source: "lifecycle",
          kind: "truncated",
          text: "Captured output reached configured limit",
        });
      }
      return;
    }
    if (output) this.bytes += size;
    this.enqueue(safe);
    if (this.queuedBytes >= BACKPRESSURE_BYTES) {
      // The reader pauses until persistence catches up or the recorder aborts the job.
      return this.flush().catch(() => undefined);
    }
    if (this.queuedBytes >= FLUSH_BYTES && !this.writing) {
      void this.flush().catch(() => undefined);
    }
  };
  private enqueue(event: ExecutionEvent): void {
    this.pending.push({ ...event, sequence: ++this.sequence });
    this.queuedBytes += Buffer.byteLength(JSON.stringify(event));
  }
  phase(value: string): void {
    this.observe({ source: "lifecycle", kind: "phase", text: value });
  }
  private flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.writing) return this.writing;
    if (!this.pending.length) return Promise.resolve();
    this.writing = this.drain();
    return this.writing;
  }
  private async drain(): Promise<void> {
    try {
      while (this.pending.length) {
        const batch = this.pending;
        const batchBytes = this.queuedBytes;
        this.pending = [];
        await this.append(batch);
        // Count the batch against the watermark until the write succeeds.
        this.queuedBytes -= batchBytes;
      }
    } finally {
      this.writing = undefined;
    }
  }
  private async append(batch: JournalEvent[]): Promise<void> {
    let last: unknown;
    for (let retry = 0; retry < 3; retry++) {
      try {
        await this.queue.append(this.id, this.attempt, this.worker, batch);
        return;
      } catch (error) {
        last = error;
        if (retry < 2) await new Promise((r) => setTimeout(r, 100 * (retry + 1)));
      }
    }
    const failure = new Error("Unable to persist attempt output", { cause: last });
    this.fail(failure);
    throw failure;
  }
  async finish(): Promise<boolean> {
    clearInterval(this.timer);
    try {
      await this.flush();
      return !this.failure;
    } catch {
      return false;
    }
  }
  get error(): Error | undefined {
    return this.failure;
  }
  get sequenceNumber(): number {
    return this.sequence;
  }
  private fail(error: Error): void {
    if (!this.failure) {
      this.failure = error;
      this.abort(error);
    }
  }
}
