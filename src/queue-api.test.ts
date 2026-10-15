import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { describe, expect, test, vi } from "vitest";
import { QueueApi } from "./queue-api.js";
import type { ServiceConfig } from "./types.js";

function transactionHarness(fail?: (sql: string) => Error | undefined) {
  const query = vi.fn(async (sql: string) => {
    const error = fail?.(sql);
    if (error) throw error;
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const queue = new QueueApi(pool, { databaseSchema: "public", databaseTable: "agent_runs" } as ServiceConfig);
  return { queue, query, release, client };
}

describe("QueueApi transaction isolation after persistence failure", () => {
  test("rolls back the first UPDATE timeout and discards a client whose read timed out", async () => {
    const failure = new Error("Query read timeout");
    const h = transactionHarness((sql) => sql === "UPDATE synthetic" ? failure : undefined);
    await expect(h.queue.transaction(async (client) => { await client.query("UPDATE synthetic"); })).rejects.toBe(failure);
    expect(h.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SET LOCAL statement_timeout = '15s'", "UPDATE synthetic", "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.client.listenerCount("error")).toBe(0);
  });

  test("preserves an uncertain COMMIT error for the completion receipt readback", async () => {
    const failure = new Error("Query read timeout");
    const h = transactionHarness((sql) => sql === "COMMIT" ? failure : undefined);
    await expect(h.queue.transaction(async () => "result already written")).rejects.toBe(failure);
    expect(h.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SET LOCAL statement_timeout = '15s'", "COMMIT", "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  test("returns a statement-cancelled client only after a successful rollback", async () => {
    const failure = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const h = transactionHarness((sql) => sql === "UPDATE synthetic" ? failure : undefined);
    await expect(h.queue.transaction(async (client) => { await client.query("UPDATE synthetic"); })).rejects.toBe(failure);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  test("discards clients after rollback failure while retaining the original error", async () => {
    const failure = new Error("connection interrupted");
    const h = transactionHarness((sql) => sql === "ROLLBACK" ? new Error("connection terminated") : undefined);
    await expect(h.queue.transaction(async () => { throw failure; })).rejects.toBe(failure);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  test("connection error events discard the connection and remove the scoped listener", async () => {
    const failure = new Error("socket closed");
    const h = transactionHarness();
    expect(await h.queue.transaction(async () => { h.client.emit("error", failure); return "saved"; })).toBe("saved");
    expect(h.release).toHaveBeenCalledExactlyOnceWith(failure);
    expect(h.client.listenerCount("error")).toBe(0);
  });
});
