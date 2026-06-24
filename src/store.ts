import { Pool, type PoolClient } from "pg";
import { parseAgentMode, parseAgentProvider } from "./config.js";
import { qualifiedTable } from "./sql.js";
import { resolveRunConfig } from "./selection.js";
import type { AgentRunRow, ClaimedRun, ExecutionResult, ServiceConfig, WorkspaceResult } from "./types.js";

export class AgentRunStore {
  private readonly pool: Pool;
  private readonly table: string;

  constructor(private readonly config: ServiceConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
    this.table = qualifiedTable(config);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async setup(): Promise<void> {
    const { migrationSql } = await import("./sql.js");
    await this.pool.query(migrationSql(this.config));
  }

  async dropTable(): Promise<void> {
    const { dropTableSql } = await import("./sql.js");
    await this.pool.query(dropTableSql(this.config));
  }

  async countQueued(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.table} WHERE status IN ('queued', 'retry')`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listRuns(limit = 200): Promise<AgentRunRow[]> {
    const result = await this.pool.query<AgentRunRow>(
      `SELECT * FROM ${this.table}
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async getRun(id: number): Promise<AgentRunRow | undefined> {
    const result = await this.pool.query<AgentRunRow>(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return result.rows[0];
  }

  async completedRunsOldestFirst(limit = 10_000): Promise<AgentRunRow[]> {
    const result = await this.pool.query<AgentRunRow>(
      `SELECT * FROM ${this.table}
       WHERE worktree_path IS NOT NULL
         AND status IN ('succeeded', 'failed')
       ORDER BY COALESCE(finished_at, updated_at, created_at) ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async recoverStaleRuns(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.table}
       SET status = CASE
             WHEN COALESCE(attempts, 0) <= COALESCE(num_retries, 0) THEN 'retry'
             ELSE 'failed'
           END,
           finished_at = CASE
             WHEN COALESCE(attempts, 0) <= COALESCE(num_retries, 0) THEN finished_at
             ELSE COALESCE(finished_at, NOW())
           END,
           updated_at = NOW(),
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL,
           error = COALESCE(error, $2::jsonb)
       WHERE status = 'running'
         AND heartbeat_at IS NOT NULL
         AND heartbeat_at < NOW() - ($1::text)::interval`,
      [`${this.config.staleAfterMs} milliseconds`, JSON.stringify({ message: "runner heartbeat expired" })],
    );
    return result.rowCount ?? 0;
  }

  async claimNext(workerId: string): Promise<ClaimedRun | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<AgentRunRow>(
        `SELECT * FROM ${this.table}
         WHERE status IN ('queued', 'retry')
         ORDER BY priority DESC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }

      let resolved;
      try {
        resolved = resolveRunConfig(row, this.config);
        parseAgentProvider(resolved.provider);
        parseAgentMode(resolved.mode);
      } catch (error) {
        await this.markInvalidClaim(client, row, error);
        await client.query("COMMIT");
        return undefined;
      }

      const updated = await client.query<AgentRunRow>(
        `UPDATE ${this.table}
         SET status = 'running',
             attempts = COALESCE(attempts, 0) + 1,
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW(),
             locked_by = $2,
             locked_at = NOW(),
             heartbeat_at = NOW(),
             agent_provider = $3,
             agent_mode = $4,
             model_name = $5,
             reasoning_effort = $6
         WHERE id = $1
         RETURNING *`,
        [row.id, workerId, resolved.provider, resolved.mode, resolved.modelName ?? null, resolved.reasoningEffort ?? null],
      );
      await client.query("COMMIT");
      return { row: updated.rows[0], resolved };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(id: number, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table}
       SET heartbeat_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [id, workerId],
    );
  }

  async recordWorkspace(id: number, workerId: string, workspace: WorkspaceResult): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table}
       SET repo_path = $3,
           worktree_path = $4,
           branch_name = $5,
           base_branch = $6,
           setup_logs = COALESCE($7, setup_logs),
           cleanup_note = COALESCE($8, cleanup_note),
           updated_at = NOW()
       WHERE id = $1 AND locked_by = $2`,
      [
        id,
        workerId,
        workspace.repoPath ?? null,
        workspace.worktreePath ?? null,
        workspace.branchName ?? null,
        workspace.baseBranch ?? null,
        workspace.setupLogs ?? null,
        workspace.cleanupNote ?? null,
      ],
    );
  }

  async markSucceeded(id: number, workerId: string, result: ExecutionResult): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table}
       SET status = 'succeeded',
           finished_at = NOW(),
           updated_at = NOW(),
           link = $3,
           last_message = $4,
           conversation = $5::jsonb,
           logs = $6,
           result = $7::jsonb,
           exit_code = $8,
           setup_logs = COALESCE($9, setup_logs),
           cleanup_note = COALESCE($10, cleanup_note),
           error = NULL,
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL
       WHERE id = $1 AND locked_by = $2`,
      [
        id,
        workerId,
        result.link ?? null,
        result.lastMessage ?? null,
        JSON.stringify(result.conversation ?? null),
        result.logs,
        JSON.stringify(result.result ?? null),
        result.exitCode,
        result.workspace?.setupLogs ?? null,
        result.workspace?.cleanupNote ?? null,
      ],
    );
  }

  async markFailed(id: number, workerId: string, run: AgentRunRow, error: unknown, result?: ExecutionResult): Promise<void> {
    const attempts = run.attempts ?? 1;
    const retries = run.num_retries ?? 0;
    const shouldRetry = attempts <= retries;
    await this.pool.query(
      `UPDATE ${this.table}
       SET status = $3,
           finished_at = CASE WHEN $3 = 'failed' THEN NOW() ELSE finished_at END,
           updated_at = NOW(),
           link = COALESCE($4, link),
           last_message = COALESCE($5, last_message),
           conversation = COALESCE($6::jsonb, conversation),
           logs = COALESCE($7, logs),
           result = COALESCE($8::jsonb, result),
           exit_code = $9,
           error = $10::jsonb,
           setup_logs = COALESCE($11, setup_logs),
           cleanup_note = COALESCE($12, cleanup_note),
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL
       WHERE id = $1 AND locked_by = $2`,
      [
        id,
        workerId,
        shouldRetry ? "retry" : "failed",
        result?.link ?? null,
        result?.lastMessage ?? null,
        result?.conversation === undefined ? null : JSON.stringify(result.conversation),
        result?.logs ?? null,
        result?.result === undefined ? null : JSON.stringify(result.result),
        result?.exitCode ?? 1,
        JSON.stringify(errorToJson(error)),
        result?.workspace?.setupLogs ?? null,
        result?.workspace?.cleanupNote ?? null,
      ],
    );
  }

  private async markInvalidClaim(client: PoolClient, row: AgentRunRow, error: unknown): Promise<void> {
    await client.query(
      `UPDATE ${this.table}
       SET status = 'failed',
           finished_at = NOW(),
           updated_at = NOW(),
           error = $2::jsonb
       WHERE id = $1`,
      [row.id, JSON.stringify(errorToJson(error))],
    );
  }
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}
