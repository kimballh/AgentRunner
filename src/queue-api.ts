import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import { companionTable, qualifiedTable } from "./sql.js";
import { redactValue, redactSecrets } from "./redact.js";
import type { AgentRunRow, ExecutionEvent, ExecutionResult, ServiceConfig } from "./types.js";

export class QueueError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface Principal {
  issuer: string;
  subject: string;
}
export interface JobInput {
  request_id: string;
  job_id?: number;
  prompt: string;
  uid?: string;
  provider?: "codex" | "claude";
  mode?: "exec" | "app-server";
  model?: string;
  reasoning_effort?: string;
  priority?: number;
  retry_count?: number;
  base_branch?: string;
  reuse_session?: boolean;
}
export interface JournalEvent extends ExecutionEvent {
  sequence: number;
}
export interface OutputInput {
  job_id: number;
  attempt_number?: number;
  source: "logs" | "setup" | "conversation";
  tail_count?: number;
  cursor?: string;
  limit?: number;
}

export class QueueApi {
  readonly attempts: string;
  readonly events: string;
  readonly receipts: string;
  private readonly table: string;
  constructor(
    private readonly pool: Pool,
    private readonly config: ServiceConfig,
  ) {
    this.table = qualifiedTable(config);
    this.attempts = companionTable(config, "attempts");
    this.events = companionTable(config, "events");
    this.receipts = companionTable(config, "mcp_requests");
  }
  async validate(): Promise<void> {
    try {
      await this.pool.query(`SELECT cancel_requested_at, requested_agent_provider FROM ${this.table} LIMIT 0`);
      await this.pool.query(`SELECT configuration, output_complete FROM ${this.attempts} LIMIT 0`);
      await this.pool.query(`SELECT sequence, data FROM ${this.events} LIMIT 0`);
      await this.pool.query(`SELECT arguments_hash, response FROM ${this.receipts} LIMIT 0`);
    } catch {
      throw new Error("Queue history tables unavailable; run agentrunner setup-db (without --force) first");
    }
  }
  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let connectionError: Error | undefined;
    let discard = false;
    const onError = (error: Error): void => {
      connectionError = error;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
      if (error instanceof Error && error.message === "Query read timeout") discard = true;
      throw error;
    } finally {
      client.removeListener("error", onError);
      client.release(connectionError ?? discard);
    }
  }
  async mutate(
    principal: Principal,
    operation: string,
    input: JobInput | { request_id: string; job_id: number },
  ): Promise<Record<string, unknown>> {
    const hash = createHash("sha256").update(canonical(input)).digest("hex");
    const result = await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        canonical([this.receipts, principal.issuer, principal.subject, input.request_id]),
      ]);
      const old = await client.query(
        `SELECT operation, arguments_hash, response FROM ${this.receipts} WHERE issuer=$1 AND subject=$2 AND request_id=$3`,
        [principal.issuer, principal.subject, input.request_id],
      );
      if (old.rows[0]) {
        if (old.rows[0].operation !== operation || old.rows[0].arguments_hash !== hash)
          throw new QueueError("conflict", "request_id was already used with different arguments");
        return old.rows[0].response as Record<string, unknown>;
      }
      let response: Record<string, unknown>;
      if (operation === "upsert_job") response = await this.upsert(client, principal, input as JobInput);
      else if (operation === "cancel_job" || operation === "retry_job") {
        const id = input.job_id!;
        const row = await this.lockJob(client, id);
        if (operation === "cancel_job") {
          if (!["queued", "retry", "running", "cancelled"].includes(row.status))
            throw new QueueError("invalid_state", `Cannot cancel ${row.status} job`);
          await this.cancel(client, id);
          response = {
            job_id: id,
            status: row.status === "running" ? "running" : "cancelled",
            cancellation_requested: true,
          };
        } else {
          if (!["failed", "cancelled"].includes(row.status))
            throw new QueueError("invalid_state", "Only failed or cancelled jobs can be retried");
          await this.retry(client, id);
          response = { job_id: id, status: "retry" };
        }
      } else throw new QueueError("invalid_arguments", "Unknown mutation");
      await client.query(
        `INSERT INTO ${this.receipts} (issuer,subject,request_id,operation,arguments_hash,run_id,response) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [principal.issuer, principal.subject, input.request_id, operation, hash, response.job_id, json(response)],
      );
      return response;
    });
    console.log(
      JSON.stringify({
        event: "mcp_mutation",
        subject: principal.subject,
        issuer: principal.issuer,
        operation,
        request_id: input.request_id,
        job_id: result.job_id,
        outcome: "accepted",
      }),
    );
    return result;
  }
  private async lockJob(client: PoolClient, id: number): Promise<AgentRunRow> {
    const row = (await client.query<AgentRunRow>(`SELECT * FROM ${this.table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw new QueueError("not_found", "Job does not exist");
    return row;
  }
  private async upsert(client: PoolClient, principal: Principal, input: JobInput): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(input.prompt) > 65536) throw new QueueError("invalid_arguments", "Prompt exceeds 64 KiB");
    // Serialize admissions across MCP instances; receipts make successful retries free.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${this.table}:mcp-admission`]);
    const recent = await client.query(
      `SELECT count(*)::integer AS count FROM ${this.receipts} WHERE issuer=$1 AND subject=$2 AND operation='upsert_job' AND created_at > now()-interval '1 minute'`,
      [principal.issuer, principal.subject],
    );
    if (recent.rows[0].count >= (this.config.mcp?.submissionsPerMinute ?? 30))
      throw new QueueError("rate_limited", "Submission limit reached; retry after one minute");
    const fields: Record<string, unknown> = { prompt: input.prompt };
    const mapping = {
      uid: "uid",
      provider: "agent_provider",
      mode: "agent_mode",
      model: "model_name",
      reasoning_effort: "reasoning_effort",
      priority: "priority",
      retry_count: "num_retries",
      base_branch: "base_branch",
      reuse_session: "reuse_session",
    } as const;
    for (const [key, column] of Object.entries(mapping)) {
      const value = input[key as keyof JobInput];
      if (value !== undefined) fields[column] = value;
    }
    if (input.job_id !== undefined) {
      const row = await this.lockJob(client, input.job_id);
      if (!["queued", "retry"].includes(row.status) || (row.attempts ?? 0) !== 0)
        throw new QueueError("invalid_state", "Only pending jobs that have never started can be edited");
      const entries = Object.entries(fields);
      const requested = requestedInput(input);
      await client.query(
        `UPDATE ${this.table} SET raw_webhook_data=jsonb_set(coalesce(raw_webhook_data,'{}'::jsonb),'{requested}',coalesce(raw_webhook_data->'requested','{}'::jsonb) || $${entries.length + 2}::jsonb), ${entries.map(([key], i) => `${key}=$${i + 2}`).join(",")}, updated_at=now() WHERE id=$1`,
        [row.id, ...entries.map(([, v]) => v), json(requested)],
      );
      return { job_id: row.id, status: row.status, created: false };
    }
    const pending = await client.query(
      `SELECT count(*)::integer AS count FROM ${this.table} WHERE status IN ('queued','retry')`,
    );
    if (pending.rows[0].count >= (this.config.mcp?.maxPendingJobs ?? 1000))
      throw new QueueError("queue_full", "Pending queue limit reached");
    Object.assign(fields, {
      uid: input.uid ?? randomUUID(),
      status: "queued",
      priority: input.priority ?? 0,
      attempts: 0,
      num_retries: input.retry_count ?? 0,
      raw_webhook_data: json({
        source: "mcp",
        subject: principal.subject,
        request_id: input.request_id,
        requested: requestedInput(input),
      }),
    });
    const entries = Object.entries(fields);
    const created = await client.query(
      `INSERT INTO ${this.table} (${entries.map(([k]) => k).join(",")},created_at) VALUES (${entries.map((_, i) => `$${i + 1}`).join(",")},now()) RETURNING id`,
      entries.map(([, v]) => v),
    );
    return { job_id: created.rows[0].id, status: "queued", created: true };
  }
  async cancel(client: PoolClient | Pool, id: number): Promise<AgentRunRow | undefined> {
    return (
      await client.query<AgentRunRow>(
        `UPDATE ${this.table} SET cancel_requested_at=coalesce(cancel_requested_at,now()), updated_at=now(), status=CASE WHEN status='running' THEN status ELSE 'cancelled' END, finished_at=CASE WHEN status='running' THEN finished_at ELSE coalesce(finished_at,now()) END WHERE id=$1 AND status IN ('queued','retry','running','cancelled') RETURNING *`,
        [id],
      )
    ).rows[0];
  }
  async retry(client: PoolClient | Pool, id: number): Promise<boolean> {
    const r = await client.query(
      `UPDATE ${this.table} SET status='retry', num_retries=greatest(coalesce(num_retries,0),coalesce(attempts,0)), finished_at=NULL,updated_at=now(),locked_by=NULL,locked_at=NULL,heartbeat_at=NULL,cancel_requested_at=NULL WHERE id=$1 AND status IN ('failed','cancelled') RETURNING id`,
      [id],
    );
    return !!r.rows[0];
  }
  async getStatus(): Promise<Record<string, unknown>> {
    const counts = await this.pool.query(`SELECT status,count(*)::integer AS count FROM ${this.table} GROUP BY status`);
    const running = await this.pool.query(
      `SELECT r.id,r.locked_by,r.heartbeat_at::timestamptz AS heartbeat_at,r.cancel_requested_at::timestamptz AS cancel_requested_at,a.host,a.phase,(extract(epoch FROM (now()-r.heartbeat_at))*1000)::float8 AS heartbeat_age_ms, r.heartbeat_at < now()-($1::text)::interval AS stale FROM ${this.table} r LEFT JOIN ${this.attempts} a ON a.run_id=r.id AND a.attempt_number=r.attempts WHERE r.status='running' ORDER BY r.id LIMIT 100`,
      [`${this.config.staleAfterMs} milliseconds`],
    );
    const activity = await this.pool.query(
      `SELECT greatest((SELECT max(updated_at) FROM ${this.table}),(SELECT max(recorded_at) FROM ${this.events})) AS latest_activity`,
    );
    return {
      counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.count])),
      running: running.rows,
      ...activity.rows[0],
      idle_capacity: null,
    };
  }
  async listJobs(input: {
    limit?: number;
    cursor?: string;
    status?: string;
    uid?: string;
    provider?: string;
    updated_since?: string;
  }): Promise<Record<string, unknown>> {
    const limit = input.limit ?? 25;
    const params: unknown[] = [];
    const where: string[] = [];
    for (const [key, column] of [
      ["status", "status"],
      ["uid", "uid"],
      ["provider", "coalesce(agent_provider,requested_agent_provider)"],
      ["updated_since", "updated_at"],
    ] as const) {
      if (input[key] !== undefined) {
        params.push(input[key]);
        where.push(
          `${column}${key === "updated_since" ? ">=" : "="}$${params.length}${key === "updated_since" ? "::timestamptz" : ""}`,
        );
      }
    }
    if (input.cursor) {
      const c = decodeCursor(input.cursor);
      if (typeof c.created_at !== "string" || !Number.isInteger(c.id))
        throw new QueueError("invalid_arguments", "Invalid job cursor");
      params.push(c.created_at, c.id);
      where.push(`(created_at,id)<($${params.length - 1}::timestamp,$${params.length}::integer)`);
    }
    params.push(limit + 1);
    const r = await this.pool.query(
      `SELECT id,status,uid,left(prompt,240) AS prompt_preview,priority,attempts,created_at::timestamptz AS created_at,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at_cursor,updated_at::timestamptz AS updated_at,finished_at::timestamptz AS finished_at,agent_provider,agent_mode,model_name,reasoning_effort,num_retries,cancel_requested_at::timestamptz AS cancel_requested_at,left(last_message,1024) AS last_message FROM ${this.table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
      params,
    );
    const jobs = r.rows.slice(0, limit);
    const last = jobs.at(-1);
    return redactValue({
      jobs,
      next_cursor:
        r.rows.length > limit && last ? encodeCursor({ created_at: last.created_at_cursor, id: last.id }) : null,
    });
  }
  async getJob(id: number): Promise<Record<string, unknown>> {
    const r = await this.pool.query(
      `SELECT CASE WHEN raw_webhook_data->>'source'='mcp' AND jsonb_typeof(raw_webhook_data->'requested')='object' THEN raw_webhook_data->'requested' END AS submitted_configuration,id,status,uid,left(prompt,65536) AS prompt,octet_length(prompt)>65536 AS prompt_truncated,priority,attempts,created_at::timestamptz AS created_at,started_at::timestamptz AS started_at,finished_at::timestamptz AS finished_at,updated_at::timestamptz AS updated_at,agent_provider,agent_mode,model_name,reasoning_effort,requested_agent_provider,requested_agent_mode,requested_model_name,requested_reasoning_effort,num_retries,locked_by,heartbeat_at::timestamptz AS heartbeat_at,cancel_requested_at::timestamptz AS cancel_requested_at,repo_path,worktree_path,workspace_mode,branch_name,base_branch,session_id,reused_from_run_id,reuse_fallback_reason,link,exit_code,left(last_message,8192) AS last_message,left(error::text,8192) AS error,left(result::text,8192) AS result,octet_length(coalesce(last_message,''))>8192 OR octet_length(coalesce(error::text,''))>8192 OR octet_length(coalesce(result::text,''))>8192 AS details_truncated FROM ${this.table} WHERE id=$1`,
      [id],
    );
    const job = r.rows[0];
    if (!job) throw new QueueError("not_found", "Job does not exist");
    const attempts = await this.listAttempts(id, 25);
    const latest = (attempts.attempts as Record<string, unknown>[])[0];
    return redactValue({
      ...job,
      requested: job.submitted_configuration ?? {
        provider: job.requested_agent_provider ?? job.agent_provider,
        mode: job.requested_agent_mode ?? job.agent_mode,
        model: job.requested_model_name ?? job.model_name,
        reasoning_effort: job.requested_reasoning_effort ?? job.reasoning_effort,
      },
      effective: job.attempts
        ? {
            provider: job.agent_provider,
            mode: job.agent_mode,
            model: job.model_name,
            reasoning_effort: job.reasoning_effort,
          }
        : null,
      prompt: clipBytes(job.prompt, 65536),
      error: parseMaybe(job.error),
      result: parseMaybe(job.result),
      cancellation_requested: !!job.cancel_requested_at,
      phase: job.status === "running" ? (latest?.phase ?? null) : job.status,
      worker_host: latest?.host ?? null,
      history: attempts,
      output_availability: latest ? "journal" : "legacy_snapshot",
    });
  }
  async listAttempts(id: number, limit = 25, before?: number): Promise<Record<string, unknown>> {
    const exists = await this.pool.query(`SELECT id FROM ${this.table} WHERE id=$1`, [id]);
    if (!exists.rows[0]) throw new QueueError("not_found", "Job does not exist");
    const r = await this.pool.query(
      `SELECT run_id,attempt_number,worker_id,host,configuration,phase,status,started_at,finished_at,metadata,left(last_message,4096) AS last_message,left(error::text,4096) AS error,left(result::text,8192) AS result,octet_length(coalesce(error::text,''))>4096 OR octet_length(coalesce(result::text,''))>8192 AS details_truncated,exit_code,output_complete,truncated FROM ${this.attempts} WHERE run_id=$1 AND ($2::integer IS NULL OR attempt_number<$2) ORDER BY attempt_number DESC LIMIT $3`,
      [id, before ?? null, limit + 1],
    );
    const attempts = r.rows
      .slice(0, limit)
      .map((row) => ({ ...row, error: parseMaybe(row.error), result: parseMaybe(row.result) }));
    return redactValue({
      attempts,
      next_before: r.rows.length > limit ? attempts.at(-1)?.attempt_number : null,
      availability: attempts.length ? "journal" : "legacy_snapshot",
    });
  }
  async output(input: OutputInput): Promise<Record<string, unknown>> {
    if (input.cursor && input.tail_count !== undefined)
      throw new QueueError("invalid_arguments", "Use cursor or tail_count, not both");
    const exists = await this.pool.query(`SELECT id FROM ${this.table} WHERE id=$1`, [input.job_id]);
    if (!exists.rows[0]) throw new QueueError("not_found", "Job does not exist");
    const attempt = (
      await this.pool.query(
        `SELECT attempt_number,output_complete,truncated FROM ${this.attempts} WHERE run_id=$1 AND ($2::integer IS NULL OR attempt_number=$2) ORDER BY attempt_number DESC LIMIT 1`,
        [input.job_id, input.attempt_number ?? null],
      )
    ).rows[0];
    if (!attempt) {
      if (input.attempt_number !== undefined || input.cursor)
        throw new QueueError("not_found", "Attempt journal is unavailable");
      const col = input.source === "logs" ? "logs" : input.source === "setup" ? "setup_logs" : "conversation::text";
      const row = (
        await this.pool.query(
          `SELECT right(coalesce(${col},''),65536) AS text,octet_length(coalesce(${col},''))>65536 AS truncated FROM ${this.table} WHERE id=$1`,
          [input.job_id],
        )
      ).rows[0];
      return {
        availability: "legacy_snapshot",
        live_output_available: false,
        output_complete: false,
        text: clipJsonBytes(
          redactSecrets(row.text)
            .split(/\r?\n/)
            .slice(-(input.tail_count ?? 100))
            .join("\n"),
          55000,
        ),
        truncated: row.truncated || Buffer.byteLength(JSON.stringify(row.text)) > 55000,
        next_cursor: null,
      };
    }
    let after = 0;
    if (input.cursor) {
      const c = decodeCursor(input.cursor);
      if (
        c.job_id !== input.job_id ||
        c.attempt !== attempt.attempt_number ||
        c.source !== input.source ||
        !Number.isSafeInteger(c.sequence) ||
        Number(c.sequence) < 0
      )
        throw new QueueError("invalid_arguments", "Cursor does not match requested output");
      after = Number(c.sequence);
    }
    const tail = !input.cursor && (input.tail_count !== undefined || input.limit === undefined);
    const limit = input.tail_count ?? input.limit ?? 100;
    const r = await this.pool.query(
      `SELECT sequence::float8 AS sequence,recorded_at,source,kind,left(text,65536) AS text,CASE WHEN octet_length(coalesce(data::text,''))>60000 THEN jsonb_build_object('truncated',true,'preview',left(data::text,12000)) ELSE data END AS data FROM ${this.events} WHERE run_id=$1 AND attempt_number=$2 AND source=$3 AND sequence>$4 ORDER BY sequence ${tail ? "DESC" : "ASC"} LIMIT $5`,
      [input.job_id, attempt.attempt_number, input.source, after, limit + 1],
    );
    let rows = r.rows.slice(0, limit);
    if (tail) rows.reverse();
    let bytes = 0;
    const selected: Record<string, unknown>[] = [];
    let pageTruncated = false;
    const ordered = tail ? [...rows].reverse() : rows;
    for (const row of ordered) {
      const safe = redactValue(row);
      const size = Buffer.byteLength(JSON.stringify(safe));
      if (bytes + size > 60000) {
        if (!selected.length)
          selected.push({
            ...safe,
            text: clipJsonBytes(String(safe.text ?? ""), 55000),
            data: { truncated: true },
          });
        pageTruncated = true;
        break;
      }
      selected.push(safe);
      bytes += size;
    }
    if (tail) selected.reverse();
    const sequence = Number(selected.at(-1)?.sequence ?? after);
    return {
      availability: "journal",
      attempt_number: attempt.attempt_number,
      events: selected,
      output_complete: attempt.output_complete,
      truncated: attempt.truncated || pageTruncated,
      has_more: !tail && r.rows.length > selected.length,
      next_cursor: encodeCursor({
        job_id: input.job_id,
        attempt: attempt.attempt_number,
        source: input.source,
        sequence,
      }),
    };
  }
  async beginAttempt(client: PoolClient, row: AgentRunRow, worker: string): Promise<void> {
    await client.query(
      `INSERT INTO ${this.attempts} (run_id,attempt_number,worker_id,host,prompt,configuration,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [row.id, row.attempts, worker, hostname(), cleanText(row.prompt), json(configuration(row)), json(metadata(row))],
    );
  }
  async append(id: number, attempt: number, worker: string, events: JournalEvent[]): Promise<void> {
    if (!events.length) return;
    await this.transaction(async (client) => {
      const owned = await client.query(
        `SELECT id FROM ${this.table} WHERE id=$1 AND attempts=$2 AND locked_by=$3 AND status='running' FOR UPDATE`,
        [id, attempt, worker],
      );
      if (!owned.rows[0]) throw new QueueError("lost_ownership", "Worker no longer owns this attempt");
      const batch = events.map((event) => ({
        sequence: event.sequence,
        source: event.source,
        kind: event.kind,
        text: event.text === undefined ? null : cleanText(redactSecrets(event.text)),
        data: event.data === undefined ? null : redactValue(event.data),
      }));
      await client.query(
        `INSERT INTO ${this.events} (run_id,attempt_number,sequence,source,kind,text,data)
         SELECT $1,$2,e.sequence,e.source,e.kind,e.text,e.data
         FROM jsonb_to_recordset($3::jsonb) AS e(sequence bigint,source text,kind text,text text,data jsonb)
         ON CONFLICT DO NOTHING`,
        [id, attempt, json(batch)],
      );
      const phase = [...events].reverse().find((e) => e.kind === "phase")?.text;
      const session = [...events].reverse().find((e) => e.kind === "session")?.text;
      await client.query(
        `UPDATE ${this.attempts} SET phase=coalesce($3,phase),
         truncated=truncated OR $4, metadata=metadata || $5::jsonb
         WHERE run_id=$1 AND attempt_number=$2 AND status='running'`,
        [
          id,
          attempt,
          phase ?? null,
          events.some((e) => e.kind === "truncated"),
          json(session ? { session_id: session } : {}),
        ],
      );
    });
  }
  async finishAttempt(client: PoolClient, row: AgentRunRow, result?: ExecutionResult): Promise<void> {
    await client.query(
      `UPDATE ${this.attempts} SET status=$3,phase='finished',finished_at=now(),metadata=metadata || jsonb_strip_nulls($4::jsonb),configuration=$5::jsonb,result=$6::jsonb,error=$7::jsonb,exit_code=$8,last_message=$9,output_complete=$10 WHERE run_id=$1 AND attempt_number=$2 AND status='running'`,
      [
        row.id,
        row.attempts,
        row.status === "retry" ? "failed" : row.status,
        json(metadata(row)),
        json(configuration(row)),
        json(redactValue(result?.result ?? null)),
        json(redactValue(row.error)),
        result?.exitCode ?? row.exit_code,
        cleanText(redactSecrets(result?.lastMessage ?? "")),
        result?.outputComplete ?? false,
      ],
    );
  }
}
function cleanText(value: string): string {
  return value.replaceAll("\u0000", "\ufffd");
}
function json(value: unknown): string {
  return JSON.stringify(value ?? null).replace(
    /(^|[^\\])((?:\\\\)*)\\u0000/g,
    (_match, prefix: string, escaped: string) => `${prefix}${escaped}\\ufffd`,
  );
}
function configuration(row: AgentRunRow): Record<string, unknown> {
  return {
    provider: row.agent_provider,
    mode: row.agent_mode,
    model: row.model_name,
    reasoning_effort: row.reasoning_effort,
    base_branch: row.base_branch,
  };
}
function metadata(row: AgentRunRow): Record<string, unknown> {
  return {
    session_id: row.session_id,
    repo_path: row.repo_path,
    worktree_path: row.worktree_path,
    branch_name: row.branch_name,
    reused_from_run_id: row.reused_from_run_id,
    reuse_fallback_reason: row.reuse_fallback_reason,
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decodeCursor(value: string): Record<string, unknown> {
  try {
    const c = JSON.parse(Buffer.from(value, "base64url").toString());
    if (c && typeof c === "object" && !Array.isArray(c)) return c;
  } catch {}
  throw new QueueError("invalid_arguments", "Invalid cursor");
}
function parseMaybe(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { truncated: true, preview: value };
  }
}

function requestedInput(input: JobInput): Record<string, unknown> {
  return Object.fromEntries(
    ["provider", "mode", "model", "reasoning_effort", "base_branch", "reuse_session"]
      .filter((key) => input[key as keyof JobInput] !== undefined)
      .map((key) => [key, input[key as keyof JobInput]]),
  );
}

function clipBytes(value: string, limit: number): string {
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) break;
    result += char;
    bytes += size;
  }
  return result;
}

function clipJsonBytes(value: string, limit: number): string {
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + size > limit) break;
    result += char;
    bytes += size;
  }
  return result;
}
