import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { streamToString } from "./process.js";
import { AttemptRecorder } from "./recorder.js";
import type { QueueApi, JournalEvent } from "./queue-api.js";

describe("durable output capture", () => {
  test("redacts credentials across chunk boundaries before durable storage", async () => {
    const saved: JournalEvent[] = [];
    const queue = {
      append: async (_id: number, _attempt: number, _worker: string, events: JournalEvent[]) => {
        saved.push(...events);
      },
    } as QueueApi;
    const recorder = new AttemptRecorder(queue, 1, 1, "worker", () => {});
    await streamToString(
      Readable.from([
        Buffer.from("API_"),
        Buffer.from("KEY=very-secret\nAuthorization: Bea"),
        Buffer.from("rer abc.def.ghi\n"),
      ]),
      (line) => recorder.observe({ source: "logs", kind: "stdout", text: line }),
    );
    expect(await recorder.finish()).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("very-secret");
    expect(JSON.stringify(saved)).not.toContain("abc.def.ghi");
    expect(saved.map((e) => e.sequence)).toEqual([1, 2]);
  });

  test("redacts JSON credential values and truncates oversized events explicitly", async () => {
    const saved: JournalEvent[] = [];
    const queue = {
      append: async (_id: number, _a: number, _w: string, e: JournalEvent[]) => {
        saved.push(...e);
      },
    } as QueueApi;
    const r = new AttemptRecorder(queue, 1, 1, "worker", () => {});
    r.observe({
      source: "logs",
      kind: "stdout",
      text: '{"api_key":"secret-value","access_token":"token-value"}',
    });
    r.observe({
      source: "conversation",
      kind: "provider",
      data: { api_key: "nested-secret", output: "x".repeat(100000) },
    });
    await r.finish();
    expect(JSON.stringify(saved)).not.toContain("secret-value");
    expect(JSON.stringify(saved)).not.toContain("token-value");
    expect(JSON.stringify(saved)).not.toContain("nested-secret");
    expect(saved.filter((e) => e.kind === "truncated")).toHaveLength(1);
    expect(JSON.stringify(saved).length).toBeLessThan(20000);
  });
  test("caps output once but retains lifecycle events", async () => {
    const saved: JournalEvent[] = [];
    const queue = {
      append: async (_id: number, _a: number, _w: string, e: JournalEvent[]) => {
        saved.push(...e);
      },
    } as QueueApi;
    const r = new AttemptRecorder(queue, 1, 1, "worker", () => {}, 100);
    for (let i = 0; i < 10; i++) r.observe({ source: "logs", kind: "stdout", text: "x".repeat(70) });
    r.phase("finalizing");
    await r.finish();
    expect(saved.filter((e) => e.kind === "truncated")).toHaveLength(1);
    expect(saved.at(-1)?.text).toBe("finalizing");
  });
  test("aborts on persistent persistence failure without claiming complete output", async () => {
    const abort = vi.fn();
    const append = vi.fn().mockRejectedValue(new Error("offline"));
    const r = new AttemptRecorder({ append } as unknown as QueueApi, 1, 1, "worker", abort);
    r.phase("executing");
    expect(await r.finish()).toBe(false);
    expect(abort).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledTimes(3);
  });
  test("bounds a newline-free subprocess output while continuing to drain", async () => {
    const lines: string[] = [];
    const output = await streamToString(
      Readable.from(["x".repeat(100000), "\nlast\n"]),
      (line) => lines.push(line),
      20,
    );
    expect(output).toHaveLength(20);
    expect(lines).toEqual(["[oversized output line omitted]", "last"]);
  });
});
