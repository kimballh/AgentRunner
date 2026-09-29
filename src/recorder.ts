import { redactValue } from "./redact.js";
import type { QueueApi, JournalEvent } from "./queue-api.js";
import type { ExecutionEvent, ExecutionObserver } from "./types.js";

/** One writer per claimed attempt, with stable sequence numbers for ambiguous DB retries. */
export class AttemptRecorder {
  private pending: JournalEvent[] = [];
  private sequence = 0;
  private bytes = 0;
  private queuedBytes = 0;
  private truncated = false;
  private failure?: Error;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout;
  constructor(
    private queue: QueueApi,
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
    // Bound the live recording backlog independently of the lifetime output cap.
    if (this.queuedBytes > 1024 * 1024) this.fail(new Error("Attempt output recorder backlog exceeded 1 MiB"));
    else if (this.queuedBytes >= 65536) void this.flush().catch(() => undefined);
  };
  private enqueue(event: ExecutionEvent): void {
    this.pending.push({ ...event, sequence: ++this.sequence });
    this.queuedBytes += Buffer.byteLength(JSON.stringify(event));
  }
  phase(value: string): void {
    this.observe({ source: "lifecycle", kind: "phase", text: value });
  }
  async flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      const batch = this.pending.splice(0);
      this.queuedBytes = 0;
      if (!batch.length) return;
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
      this.fail(new Error("Unable to persist attempt output", { cause: last }));
      throw this.failure;
    });
    // Retain failure but attach a handler immediately for interval callers.
    void this.chain.catch(() => undefined);
    return this.chain;
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
  private fail(error: Error): void {
    if (!this.failure) {
      this.failure = error;
      this.abort(error);
    }
  }
}
