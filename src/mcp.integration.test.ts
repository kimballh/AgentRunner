import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Pool } from "pg";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import * as workspaces from "./workspace.js";
import { AgentRunnerService } from "./service.js";
import { AgentRunStore } from "./store.js";
import { startMcp } from "./mcp.js";
import type { ServiceConfig } from "./types.js";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const principal = { issuer: "https://auth.example/", subject: "owner" };
let dir: string;
let config: ServiceConfig;
let store: AgentRunStore;
let pool: Pool;
let server: Awaited<ReturnType<typeof startMcp>>;
let client: Client;
let worker: ChildProcess | undefined;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let token: string;
const schema = "mcp_test_" + Date.now();
let workerOutput = "";
let auditLog: ReturnType<typeof vi.spyOn>;
let auditWarn: ReturnType<typeof vi.spyOn>;
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
async function connect(): Promise<void> {
  client = new Client({ name: "acceptance", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
}
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await client.callTool({ name, arguments: args });
  const data = (r.structuredContent as { data: any })?.data;
  if (r.isError)
    throw Object.assign(new Error(data?.error?.message ?? JSON.stringify(r)), {
      code: data?.error?.code,
    });
  return data;
}
async function waitUntil<T>(fn: () => Promise<T>, matches: (value: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  do {
    value = await fn();
    if (matches(value)) return value;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < end);
  throw new Error("Timed out: " + JSON.stringify(value!) + " worker=" + workerOutput);
}
async function startWorker(): Promise<void> {
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "run", "--config", path.join(dir, "worker.toml")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTRUNNER_DATABASE_URL: process.env.TEST_DATABASE_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout!.on("data", (b) => (workerOutput += b.toString()));
  worker.stderr!.on("data", (b) => (workerOutput += b.toString()));
  await waitUntil(
    async () => workerOutput,
    (s) => s.includes("AgentRunner dashboard:"),
  );
}
async function stopWorker(): Promise<void> {
  if (!worker) return;
  const exited = once(worker, "exit");
  worker.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("worker shutdown timed out")), 8000)),
  ]);
  worker = undefined;
}

describeDb("HTTP MCP and shared queue acceptance", () => {
  beforeAll(async () => {
    auditLog = vi.spyOn(console, "log").mockImplementation(() => {});
    auditWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-mcp-test-"));
    config = await loadConfig(
      {
        databaseUrl: process.env.TEST_DATABASE_URL,
        databaseSchema: schema,
        databaseTable: "jobs",
        createWorktrees: "never",
        numWorkers: 1,
        pollFrequencyMs: 30,
      },
      dir,
    );
    config.preflightRetryDelayMs = 0;
    config.mcp = {
      host: "127.0.0.1",
      port: await freePort(),
      publicUrl: "https://runner.example/mcp",
      allowedOrigins: [],
      submissionsPerMinute: 1000,
      maxPendingJobs: 1000,
      oauth: {
        issuer: principal.issuer,
        audience: "https://runner.example/mcp",
        allowedSubjects: ["owner"],
      },
    };
    store = new AgentRunStore(config);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await store.setup();
    await store.setup();
    keys = await generateKeyPair("RS256");
    token = await new SignJWT({ scope: "agentrunner:access" })
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "owner-key" })
      .setIssuer(principal.issuer)
      .setAudience(config.mcp.publicUrl)
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(keys.privateKey);
    server = await startMcp(config, store, {
      keyResolver: createLocalJWKSet({
        keys: [
          {
            ...(await exportJWK(keys.publicKey)),
            alg: "RS256",
            kid: "owner-key",
          },
        ],
      }),
    });
    await connect();
    const provider = path.join(dir, "fake-claude.cjs");
    await fs.writeFile(
      provider,
      `#!/usr/bin/env node
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'system',session_id:'fixture-session'}));
 console.log(JSON.stringify({type:'assistant',text:'working',args:process.argv.slice(2)}));
 process.stderr.write('API_'+'KEY=fixture-secret\\n');
 setTimeout(()=>{console.log(JSON.stringify({type:'result',session_id:'fixture-session',result:'done',is_error:prompt.includes('FAIL')}));process.exit(0);},prompt.includes('FAST')?200:10000);
});
`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(dir, "worker.toml"),
      `database_schema = "${schema}"\ndatabase_table = "jobs"\nagent_provider = "claude"\npoll_frequency_ms = 30\npreflight_retry_delay_ms = 0\n[git]\ncreate_worktrees = "never"\nsetup = "never"\n[claude]\nbin = ${JSON.stringify(provider)}\n`,
    );
  }, 20000);
  afterAll(async () => {
    try {
      await stopWorker();
    } finally {
      await client?.close();
      await server?.close();
      await store?.close();
      await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool?.end();
      auditLog?.mockRestore();
      auditWarn?.mockRestore();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20000);
  test("discovery is public; all queue tools require owner access", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(server.url.replace("/mcp", p));
      expect(r.status).toBe(200);
      expect((await r.json()).resource).toBe(config.mcp!.publicUrl);
    }
    const denied = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(await denied.json()).toMatchObject({ reason: "missing_bearer_token" });
    const wrongType = await new SignJWT({ scope: "agentrunner:access" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "owner-key" })
      .setIssuer(principal.issuer)
      .setAudience(config.mcp!.publicUrl)
      .setSubject(principal.subject)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(keys.privateKey);
    auditWarn.mockClear();
    const wrongTypeResponse = await fetch(server.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + wrongType, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(wrongTypeResponse.status).toBe(401);
    expect(wrongTypeResponse.headers.get("www-authenticate")).toContain("RFC 9068");
    expect(await wrongTypeResponse.json()).toMatchObject({ reason: "invalid_access_token_type" });
    expect(auditWarn).toHaveBeenCalledWith(
      JSON.stringify({ component: "mcp", event: "authentication_failed", status: 401, reason: "invalid_access_token_type" }),
    );
    expect(JSON.stringify(auditWarn.mock.calls)).not.toContain(wrongType);
    const stranger = await new SignJWT({ scope: "agentrunner:access" })
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "owner-key" })
      .setIssuer(principal.issuer)
      .setAudience(config.mcp!.publicUrl)
      .setSubject("stranger")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(keys.privateKey);
    expect(
      (
        await fetch(server.url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + stranger,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(server.url, {
          headers: {
            Authorization: "Bearer " + token,
            Origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(server.url + "?access_token=" + token)).status).toBe(401);
    expect(
      (
        await fetch(server.url, {
          headers: { Authorization: "Bearer " + token },
        })
      ).status,
    ).toBe(405);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toHaveLength(8);
    expect(tools.tools.every((t) => t.outputSchema)).toBe(true);
  });
  test("schema failures return structured tool errors and body limits are enforced", async () => {
    await expect(call("get_job", { job_id: 0 })).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(call("upsert_job", { prompt: "missing receipt ID" })).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    await expect(call("upsert_job", { request_id: randomUUID(), prompt: "x".repeat(65537) })).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    const response = await fetch(server.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });
  test("concurrent duplicate submissions create exactly one row, even after MCP restart", async () => {
    const args = {
      request_id: randomUUID(),
      prompt: "duplicate",
      uid: "conversation-group",
    };
    const all = await Promise.all(Array.from({ length: 8 }, () => call("upsert_job", args)));
    expect(new Set(all.map((r) => r.job_id)).size).toBe(1);
    const job = await call("get_job", { job_id: all[0].job_id });
    expect(Math.abs(Date.parse(job.created_at) - Date.now())).toBeLessThan(30000);
    expect(job.effective).toBeNull();
    expect(job.requested).toEqual({});
    await expect(call("upsert_job", { ...args, prompt: "different" })).rejects.toMatchObject({ code: "conflict" });
    await client.close();
    await server.close();
    server = await startMcp(config, store, {
      keyResolver: createLocalJWKSet({
        keys: [{ ...(await exportJWK(keys.publicKey)), kid: "owner-key" }],
      }),
    });
    await connect();
    expect(await call("upsert_job", args)).toEqual(all[0]);
    await call("cancel_job", {
      request_id: randomUUID(),
      job_id: all[0].job_id,
    });
  });
  test("upserts pending jobs, preserves grouping semantics and paginates filters", async () => {
    const a = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "first",
      uid: "same",
    });
    const b = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "second",
      uid: "same",
    });
    expect(a.job_id).not.toBe(b.job_id);
    await call("upsert_job", {
      request_id: randomUUID(),
      job_id: a.job_id,
      prompt: "edited",
      model: "fixture-model",
      provider: "claude",
    });
    const job = await call("get_job", { job_id: a.job_id });
    expect(job.prompt).toBe("edited");
    expect(job.requested).toMatchObject({
      provider: "claude",
      model: "fixture-model",
    });
    const page = await call("list_jobs", { uid: "same", limit: 1 });
    expect(page.jobs).toHaveLength(1);
    expect(page.next_cursor).toBeTruthy();
    const next = await call("list_jobs", {
      uid: "same",
      limit: 1,
      cursor: page.next_cursor,
    });
    expect(next.jobs[0].id).not.toBe(page.jobs[0].id);
    await expect(
      call("upsert_job", {
        request_id: randomUUID(),
        job_id: 2147483647,
        prompt: "missing",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const id of [a.job_id, b.job_id]) await call("cancel_job", { request_id: randomUUID(), job_id: id });
  });
  test("pending cancellation and worker claiming are atomic", async () => {
    const a = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "race",
      provider: "claude",
    });
    const [claimed] = await Promise.all([
      store.claimNext("race-worker", "claude"),
      call("cancel_job", { request_id: randomUUID(), job_id: a.job_id }),
    ]);
    const row = await store.getRun(a.job_id);
    if (claimed) {
      expect(row?.status).toBe("running");
      expect(row?.cancel_requested_at).toBeTruthy();
      await store.markCancelled(a.job_id, "race-worker", {
        exitCode: 1,
        logs: "partial",
      });
    } else expect(row?.status).toBe("cancelled");
  });

  test("a prompt edit racing a claim matches the frozen attempt snapshot", async () => {
    const job = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "before edit",
      provider: "claude",
    });
    const [claim, edit] = await Promise.allSettled([
      store.claimNext("edit-race-worker", "claude"),
      call("upsert_job", {
        request_id: randomUUID(),
        job_id: job.job_id,
        prompt: "after edit",
      }),
    ]);
    expect(claim.status).toBe("fulfilled");
    const run = (claim as PromiseFulfilledResult<any>).value;
    const snapshots = await store.query<any>(`SELECT prompt FROM "${schema}".jobs_attempts WHERE run_id=$1`, [
      job.job_id,
    ]);
    expect(snapshots[0].prompt).toBe(run.row.prompt);
    if (edit.status === "fulfilled") expect(run.row.prompt).toBe("after edit");
    else expect(edit.reason.code).toBe("invalid_state");
    await store.markCancelled(job.job_id, "edit-race-worker", {
      exitCode: 1,
      logs: "",
    });
  });
  test("leases fence journal writes and finalization; history survives retry", async () => {
    const a = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "lease",
      provider: "claude",
    });
    const old = (await store.claimNext("old-worker", "claude"))!;
    await store.queue.append(a.job_id, old.row.attempts!, "old-worker", [
      { sequence: 1, source: "logs", kind: "stdout", text: "old attempt" },
    ]);
    await pool.query(`UPDATE "${schema}".jobs SET heartbeat_at=now()-interval '1 day' WHERE id=$1`, [a.job_id]);
    await store.recoverStaleRuns();
    await call("retry_job", { request_id: randomUUID(), job_id: a.job_id });
    const fresh = (await store.claimNext("fresh-worker", "claude"))!;
    await expect(
      store.queue.append(a.job_id, old.row.attempts!, "old-worker", [
        { sequence: 2, source: "logs", kind: "stdout", text: "late" },
      ]),
    ).rejects.toMatchObject({ code: "lost_ownership" });
    expect(
      await store.markSucceeded(a.job_id, "old-worker", {
        exitCode: 0,
        logs: "late",
      }),
    ).toBe(false);
    await store.markSucceeded(a.job_id, "fresh-worker", {
      exitCode: 0,
      logs: "fresh",
      outputComplete: true,
    });
    const attempts = await call("list_job_attempts", { job_id: a.job_id });
    expect(attempts.attempts.map((a: any) => a.status)).toEqual(["succeeded", "failed"]);
    expect(attempts.attempts[1].output_complete).toBe(false);
    const oldOutput = await call("get_job_output", {
      job_id: a.job_id,
      attempt_number: 1,
    });
    expect(JSON.stringify(oldOutput)).toContain("old attempt");
    expect(JSON.stringify(oldOutput)).not.toContain("late");
    expect(fresh.row.attempts).toBe(2);
    const same = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "same worker lease",
      provider: "claude",
    });
    const previous = (await store.claimNext("same-worker", "claude"))!;
    await store.markFailed(same.job_id, "same-worker", previous.row, new Error("first failure"));
    await call("retry_job", { request_id: randomUUID(), job_id: same.job_id });
    const current = (await store.claimNext("same-worker", "claude"))!;
    expect(
      await store.markSucceeded(same.job_id, "same-worker", { exitCode: 0, logs: "late" }, previous.row.attempts!),
    ).toBe(false);
    expect(
      await store.markCancelled(same.job_id, "same-worker", { exitCode: 1, logs: "late" }, previous.row.attempts!),
    ).toBe(false);
    expect(await store.markFailed(same.job_id, "same-worker", previous.row, new Error("late"))).toBe(false);
    await store.markSucceeded(
      same.job_id,
      "same-worker",
      { exitCode: 0, logs: "current", result: { answer: "saved" }, outputComplete: true },
      current.row.attempts!,
    );
    const preserved = await call("list_job_attempts", { job_id: same.job_id });
    expect(preserved.attempts[0].result).toEqual({ answer: "saved" });
  });
  test("bounded tails, incremental cursors and legacy snapshots are explicit", async () => {
    const a = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "output",
      provider: "claude",
    });
    const run = (await store.claimNext("output-worker", "claude"))!;
    await store.queue.append(
      a.job_id,
      1,
      "output-worker",
      Array.from({ length: 150 }, (_, i) => ({
        sequence: i + 1,
        source: "logs" as const,
        kind: "stdout",
        text: "line " + i,
      })),
    );
    const first = await call("get_job_output", { job_id: a.job_id, limit: 2 });
    expect(first.events.map((e: any) => e.text)).toEqual(["line 0", "line 1"]);
    expect(first.has_more).toBe(true);
    const second = await call("get_job_output", { job_id: a.job_id, cursor: first.next_cursor, limit: 2 });
    expect(second.events.map((e: any) => e.text)).toEqual(["line 2", "line 3"]);
    const tail = await call("get_job_output", {
      job_id: a.job_id,
      tail_count: 2,
    });
    expect(tail.events.map((e: any) => e.text)).toEqual(["line 148", "line 149"]);
    await store.queue.append(a.job_id, 1, "output-worker", [
      { sequence: 151, source: "logs", kind: "stdout", text: "line 150" },
    ]);
    const incremental = await call("get_job_output", {
      job_id: a.job_id,
      cursor: tail.next_cursor,
    });
    expect(incremental.events.map((e: any) => e.text)).toEqual(["line 150"]);
    await store.queue.append(a.job_id, 1, "output-worker", [
      {
        sequence: 152,
        source: "logs",
        kind: "stdout",
        text: "\u0001".repeat(65536),
      },
    ]);
    await store.queue.append(a.job_id, 1, "output-worker", [
      {
        sequence: 153,
        source: "conversation",
        kind: "provider",
        data: { nul: "backslash\\\u0000value", literal: "\\u0000" },
      },
    ]);
    const storedNul = await store.query<any>(
      `SELECT data FROM "${schema}".jobs_events WHERE run_id=$1 AND sequence=153`,
      [a.job_id],
    );
    expect(storedNul[0].data.nul).toBe("backslash\\\ufffdvalue");
    expect(storedNul[0].data.literal).toBe("\\u0000");
    const huge = await call("get_job_output", {
      job_id: a.job_id,
      tail_count: 1000,
    });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(65536);
    await expect(
      call("get_job_output", {
        job_id: a.job_id,
        cursor: tail.next_cursor,
        tail_count: 2,
      }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await store.markSucceeded(a.job_id, "output-worker", {
      exitCode: 0,
      logs: "done",
      outputComplete: true,
    });
    const legacy = (
      await pool.query(
        `INSERT INTO "${schema}".jobs(status,raw_webhook_data,prompt,uid,created_at,priority,logs) VALUES ('succeeded','{}','legacy','legacy',now(),0,'one\ntwo\nthree') RETURNING id`,
      )
    ).rows[0].id;
    const saved = await call("get_job_output", {
      job_id: legacy,
      tail_count: 2,
    });
    expect(saved.availability).toBe("legacy_snapshot");
    expect(saved.text).toBe("two\nthree");
  });
  test("transactional submission throttling and pending admission limits", async () => {
    const local = {
      ...config,
      mcp: { ...config.mcp!, maxPendingJobs: 1, submissionsPerMinute: 1 },
    };
    const restricted = new AgentRunStore(local);
    const user = { issuer: principal.issuer, subject: "rate-test" };
    try {
      const args = { request_id: randomUUID(), prompt: "bounded" };
      const job = await restricted.queue.mutate(user, "upsert_job", args);
      expect(await restricted.queue.mutate(user, "upsert_job", args)).toEqual(job);
      await expect(
        restricted.queue.mutate(user, "upsert_job", {
          request_id: randomUUID(),
          prompt: "excess",
        }),
      ).rejects.toMatchObject({ code: "rate_limited" });
      await expect(
        restricted.queue.mutate({ ...user, subject: "capacity-test" }, "upsert_job", {
          request_id: randomUUID(),
          prompt: "full",
        }),
      ).rejects.toMatchObject({ code: "queue_full" });
      await call("cancel_job", {
        request_id: randomUUID(),
        job_id: job.job_id,
      });
    } finally {
      await restricted.close();
    }
  });
  test("separate worker streams output, responds to cancellation and preserves both attempts", async () => {
    await startWorker();
    const job = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "SLOW",
      provider: "claude",
    });
    await waitUntil(
      () => call("get_job", { job_id: job.job_id }),
      (j) => j.status === "running",
    );
    const live = await waitUntil(
      () => call("get_job_output", { job_id: job.job_id }),
      (o) => o.events?.some((e: any) => e.text?.includes("working")),
    );
    expect(live.output_complete).toBe(false);
    expect(JSON.stringify(live)).not.toContain("fixture-secret");
    const detail = await call("get_job", { job_id: job.job_id });
    expect(detail.phase).toBe("executing");
    expect(detail.worker_host).toBeTruthy();
    expect(detail.effective.provider).toBe("claude");
    await expect(
      call("upsert_job", {
        request_id: randomUUID(),
        job_id: job.job_id,
        prompt: "edit running",
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const cancelled = await call("cancel_job", {
      request_id: randomUUID(),
      job_id: job.job_id,
    });
    expect(cancelled.cancellation_requested).toBe(true);
    await waitUntil(
      () => call("get_job", { job_id: job.job_id }),
      (j) => j.status === "cancelled",
    );
    await call("retry_job", { request_id: randomUUID(), job_id: job.job_id });
    await waitUntil(
      () => call("get_job", { job_id: job.job_id }),
      (j) => j.status === "running" && j.attempts === 2,
    );
    await waitUntil(
      () => call("get_job_output", { job_id: job.job_id }),
      (o) => o.events?.some((e: any) => e.text?.includes("working")),
    );
    await call("cancel_job", { request_id: randomUUID(), job_id: job.job_id });
    await waitUntil(
      () => call("get_job", { job_id: job.job_id }),
      (j) => j.status === "cancelled",
    );
    const history = await call("list_job_attempts", { job_id: job.job_id });
    expect(history.attempts.map((a: any) => a.status)).toEqual(["cancelled", "cancelled"]);
    expect(history.attempts.every((a: any) => a.output_complete)).toBe(true);
    const old = await call("get_job_output", {
      job_id: job.job_id,
      attempt_number: 1,
      source: "conversation",
    });
    expect(old.events.length).toBeGreaterThan(0);
  }, 15000);
  test("provider result errors are failures even with exit zero; shutdown is not user cancellation", async () => {
    const failed = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "FAST FAIL",
      provider: "claude",
    });
    await waitUntil(
      () => call("get_job", { job_id: failed.job_id }),
      (j) => j.status === "failed",
    );
    const interrupted = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "SLOW",
      provider: "claude",
      retry_count: 1,
    });
    await waitUntil(
      () => call("get_job_output", { job_id: interrupted.job_id }),
      (o) => o.events?.some((e: any) => e.text?.includes("working")),
    );
    await stopWorker();
    const row = await store.getRun(interrupted.job_id);
    expect(row?.status).toBe("retry");
    expect(row?.cancel_requested_at).toBeNull();
    expect(JSON.stringify(row?.error)).toContain("runner shutdown");
    await call("cancel_job", {
      request_id: randomUUID(),
      job_id: interrupted.job_id,
    });
  }, 15000);
  test("a missing retained session keeps both invocations and live setup in one attempt", async () => {
    const bin = path.join(dir, "resume-fixture.cjs");
    await fs.writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>{
 if(process.argv.includes('--resume')){
  console.log(JSON.stringify({type:'result',session_id:'retained-session',is_error:true,result:'session not found: resume marker'}));process.exit(1);
 }else{
  console.log(JSON.stringify({type:'system',session_id:'fresh-session'}));
  console.log(JSON.stringify({type:'result',session_id:'fresh-session',is_error:false,result:'fresh success marker'}));process.exit(0);
 }
});`,
      { mode: 0o755 },
    );
    await pool.query(
      `INSERT INTO "${schema}".jobs(status,raw_webhook_data,prompt,uid,created_at,finished_at,priority,agent_provider,agent_mode,session_id,repo_path,worktree_path) VALUES ('succeeded','{}','prior','resume-group',now(),now(),0,'claude','exec','retained-session',$1,$1)`,
      [dir],
    );
    const job = await call("upsert_job", {
      request_id: randomUUID(),
      prompt: "resume",
      uid: "resume-group",
      provider: "claude",
      reuse_session: true,
    });
    const reused = vi.spyOn(workspaces, "prepareReusedWorkspace").mockImplementation(async (input) => {
      input.observe?.({ source: "setup", kind: "stdout", text: "reused workspace preparation marker" });
      return { cwd: dir, repoPath: dir, worktreePath: dir };
    });
    const fresh = vi
      .spyOn(workspaces, "prepareWorkspace")
      .mockResolvedValue({ cwd: dir, repoPath: dir, worktreePath: dir });
    const service = new AgentRunnerService({
      ...config,
      agentProvider: "claude",
      claude: { ...config.claude, bin },
      git: {
        ...config.git,
        maxWorktrees: 0,
        setup: "always",
        setupCommand: [process.execPath, "-e", "console.log('live setup marker')"],
      },
    });
    try {
      await service.start();
      await waitUntil(
        () => call("get_job", { job_id: job.job_id }),
        (j) => j.status === "succeeded",
      );
      const history = await call("list_job_attempts", { job_id: job.job_id });
      expect(history.attempts).toHaveLength(1);
      expect(history.attempts[0].metadata.session_id).toBe("fresh-session");
      const thread = await call("get_job_output", { job_id: job.job_id, source: "conversation", limit: 100 });
      expect(JSON.stringify(thread)).toContain("resume marker");
      expect(JSON.stringify(thread)).toContain("fresh success marker");
      const setup = await call("get_job_output", { job_id: job.job_id, source: "setup" });
      expect(JSON.stringify(setup)).toContain("live setup marker");
      expect(reused).toHaveBeenCalledOnce();
      expect(fresh).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
      reused.mockRestore();
      fresh.mockRestore();
    }
  }, 10000);
});
