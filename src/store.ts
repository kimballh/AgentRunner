import { Pool, type PoolClient } from "pg";
import { parseAgentMode, parseAgentProvider } from "./config.js";
import { qualifiedTable } from "./sql.js";
import { resolveRunConfig } from "./selection.js";
import type {
  AgentRunRow,
  AgentProvider,
  ClaimedRun,
  CompletedRunForCleanup,
  ExecutionResult,
  RunListItem,
  ServiceConfig,
  WorkspaceResult,
} from "./types.js";

export interface RunListCursor {
  createdAt: string;
  id: number;
}

export interface RunListOptions {
  limit?: number;
  before?: RunListCursor;
  after?: RunListCursor;
}

export interface RunListPage {
  runs: RunListItem[];
  hasMore: boolean;
}

export type CancellationRequestResult =
  | { outcome: "requested"; lockedBy: string | null }
  | { outcome: "not-running" }
  | { outcome: "not-found" };

export type RetryRequestOutcome = "queued" | "not-failed" | "not-found";

export class AgentRunStore {
  private readonly pool: Pool;
  private readonly table: string;
  private readonly localCleanupLocks = new Map<string, Promise<void>>();

  constructor(private readonly config: ServiceConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
    this.pool.on("error", (error) => {
      console.warn(`Database connection error on idle client: ${errorMessage(error)}`);
    });
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

  async listRuns(options: RunListOptions = {}): Promise<RunListPage> {
    const limit = options.limit ?? 25;
    const cursor = options.before ?? options.after;
    const comparison = options.before ? "<" : options.after ? ">" : undefined;
    const order = options.after ? "ASC" : "DESC";
    const params: unknown[] = [limit + 1];
    let where = "";
    if (comparison && cursor) {
      params.push(cursor.createdAt, cursor.id);
      where = `WHERE (created_at, id) ${comparison} (($2::text)::timestamp, $3::integer)`;
    }

    const result = await this.pool.query<RunListItem>(
      `SELECT id,
              status,
              uid,
              created_at,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at_cursor,
              finished_at,
              link,
              last_message,
              attempts,
              priority,
              model_name,
              reasoning_effort,
              agent_provider,
              agent_mode,
              num_retries,
              started_at,
              updated_at,
              repo_path,
              worktree_path,
              branch_name,
              base_branch,
              cleanup_note,
              reuse_session,
              session_id,
              reused_from_run_id,
              reuse_fallback_reason,
              cancel_requested_at,
              error IS NOT NULL AS has_error,
              logs IS NOT NULL AND logs <> '' AS has_logs,
              setup_logs IS NOT NULL AND setup_logs <> '' AS has_setup_logs,
              conversation IS NOT NULL AS has_conversation
       FROM ${this.table}
       ${where}
       ORDER BY created_at ${order}, id ${order}
       LIMIT $1`,
      params,
    );
    const hasMore = result.rows.length > limit;
    const runs = result.rows.slice(0, limit);
    return { runs: options.after ? runs.reverse() : runs, hasMore };
  }

  async getRun(id: number): Promise<AgentRunRow | undefined> {
    const result = await this.pool.query<AgentRunRow>(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return result.rows[0];
  }

  async completedRunsOldestFirst(): Promise<CompletedRunForCleanup[]> {
    const result = await this.pool.query<CompletedRunForCleanup>(
      `SELECT id, worktree_path, branch_name, status
       FROM (
         SELECT DISTINCT ON (worktree_path)
                id,
                worktree_path,
                branch_name,
                status,
                COALESCE(finished_at, updated_at, created_at) AS completed_at
         FROM ${this.table} AS completed
         WHERE completed.worktree_path IS NOT NULL
           AND completed.worktree_removed_at IS NULL
           AND completed.status IN ('succeeded', 'failed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1
             FROM ${this.table} AS active
             WHERE active.worktree_path = completed.worktree_path
               AND active.status IN ('queued', 'retry', 'running')
           )
         ORDER BY worktree_path, COALESCE(finished_at, updated_at, created_at) DESC, id DESC
       ) AS latest_per_worktree
       ORDER BY completed_at ASC, id ASC`,
    );
    return result.rows;
  }

  async recordedWorktreePaths(): Promise<string[]> {
    const result = await this.pool.query<{ worktree_path: string }>(
      `SELECT DISTINCT worktree_path
       FROM ${this.table}
       WHERE worktree_path IS NOT NULL
         AND worktree_removed_at IS NULL`,
    );
    return result.rows.map((row) => row.worktree_path);
  }

  async withWorktreeCleanupLock<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
    const lockName = worktreeCleanupLockName(repoRoot);
    return this.withLocalCleanupLock(lockName, async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))", [lockName]);
        const result = await operation();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async markWorktreeRemoved(id: number, note: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.table}
       SET worktree_removed_at = COALESCE(worktree_removed_at, NOW()),
           cleanup_note = COALESCE(cleanup_note, $2),
           updated_at = NOW()
       WHERE worktree_path = (SELECT worktree_path FROM ${this.table} WHERE id = $1)
         AND worktree_removed_at IS NULL`,
      [id, note],
    );
  }

  async recoverStaleRuns(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.table}
       SET status = CASE
             WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
             WHEN COALESCE(attempts, 0) <= COALESCE(num_retries, 0) THEN 'retry'
             ELSE 'failed'
           END,
           finished_at = CASE
             WHEN cancel_requested_at IS NULL AND COALESCE(attempts, 0) <= COALESCE(num_retries, 0) THEN finished_at
             ELSE COALESCE(finished_at, NOW())
           END,
           updated_at = NOW(),
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL,
           error = COALESCE(error, CASE WHEN cancel_requested_at IS NOT NULL THEN $3::jsonb ELSE $2::jsonb END)
       WHERE status = 'running'
         AND heartbeat_at IS NOT NULL
         AND heartbeat_at < NOW() - ($1::text)::interval`,
      [
        `${this.config.staleAfterMs} milliseconds`,
        JSON.stringify({ message: "runner heartbeat expired" }),
        JSON.stringify({ message: "cancelled by user" }),
      ],
    );
    return result.rowCount ?? 0;
  }

  async claimNext(workerId: string, provider?: AgentProvider): Promise<ClaimedRun | undefined> {
    const client = await this.pool.connect();
    let clientError: Error | undefined;
    const onClientError = (error: Error): void => {
      clientError = error;
      console.warn(`Database connection error on active client: ${errorMessage(error)}`);
    };

    client.on("error", onClientError);
    try {
      await client.query("BEGIN");
      const selected = await client.query<AgentRunRow>(
        `SELECT candidate.* FROM ${this.table} AS candidate
         WHERE candidate.status IN ('queued', 'retry')
           AND ($1::text IS NULL OR ${this.claimProviderExpression()} = $1)
         ORDER BY candidate.priority DESC, candidate.created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [provider ?? null],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }

      let requested;
      let requestedBaseBranch: string | null | undefined;
      try {
        requested = row.requested_agent_provider
          ? this.resolvePersistedRequestedConfig(row)
          : resolveRunConfig(row, this.config);
        requestedBaseBranch = row.requested_agent_provider ? row.requested_base_branch : row.base_branch;
        parseAgentProvider(requested.provider);
        parseAgentMode(requested.mode);
      } catch (error) {
        await this.markInvalidClaim(client, row, error);
        await client.query("COMMIT");
        return undefined;
      }

      let reuseSource: AgentRunRow | undefined;
      let resolved = requested;
      let reuseFallbackReason: string | null = row.reuse_fallback_reason ?? null;
      if (row.session_id) {
        try {
          resolved = this.resolvePersistedSessionConfig(row);
        } catch (error) {
          await this.markInvalidClaim(client, row, error);
          await client.query("COMMIT");
          return undefined;
        }
      } else if (row.reuse_session) {
        const reusableRepo = await client.query<{ repo_path: string }>(
          `SELECT prior.repo_path
           FROM ${this.table} AS prior
           WHERE prior.uid = $1
             AND prior.status = 'succeeded'
             AND prior.session_id IS NOT NULL
             AND prior.repo_path IS NOT NULL
             AND prior.worktree_path IS NOT NULL
             AND prior.worktree_removed_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM ${this.table} AS active
               WHERE active.session_id = prior.session_id
                 AND active.status IN ('queued', 'retry', 'running')
             )
           ORDER BY prior.finished_at DESC NULLS LAST, prior.id DESC
           LIMIT 1`,
          [row.uid],
        );
        const reusableRepoPath = reusableRepo.rows[0]?.repo_path;
        if (reusableRepoPath) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))", [
            worktreeCleanupLockName(reusableRepoPath),
          ]);
        }
        const reusable = reusableRepoPath
          ? await client.query<AgentRunRow>(
              `SELECT prior.*
               FROM ${this.table} AS prior
               WHERE prior.uid = $1
                 AND prior.repo_path = $2
                 AND prior.status = 'succeeded'
                 AND prior.session_id IS NOT NULL
                 AND prior.worktree_path IS NOT NULL
                 AND prior.worktree_removed_at IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM ${this.table} AS active
                   WHERE active.session_id = prior.session_id
                     AND active.status IN ('queued', 'retry', 'running')
                 )
               ORDER BY prior.finished_at DESC NULLS LAST, prior.id DESC
               FOR UPDATE OF prior SKIP LOCKED
               LIMIT 1`,
              [row.uid, reusableRepoPath],
            )
          : { rows: [] as AgentRunRow[] };
        reuseSource = reusable.rows[0];
        if (reuseSource) {
          try {
            resolved = this.resolvePersistedSessionConfig(reuseSource);
            reuseFallbackReason = null;
          } catch {
            reuseSource = undefined;
            reuseFallbackReason = "latest matching run has invalid persisted provider configuration";
          }
        } else {
          reuseFallbackReason = "no available successful run with the same uid and a retained session worktree";
        }
      }

      // The provider expression above is a non-locking preview. Re-check after
      // session leasing in case another transaction changed reuse availability.
      if (provider && resolved.provider !== provider) {
        await client.query("ROLLBACK");
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
             reasoning_effort = $6,
             session_id = COALESCE(session_id, $7),
             reused_from_run_id = COALESCE(reused_from_run_id, $8),
             repo_path = COALESCE(repo_path, $9),
             worktree_path = COALESCE(worktree_path, $10),
             branch_name = COALESCE(branch_name, $11),
             base_branch = COALESCE($12, base_branch),
             reuse_fallback_reason = $13,
             requested_agent_provider = COALESCE(requested_agent_provider, $14),
             requested_agent_mode = COALESCE(requested_agent_mode, $15),
             requested_model_name = COALESCE(requested_model_name, $16),
             requested_reasoning_effort = COALESCE(requested_reasoning_effort, $17),
             requested_base_branch = CASE
               WHEN requested_agent_provider IS NULL THEN $18
               ELSE requested_base_branch
             END
         WHERE id = $1
         RETURNING *`,
        [
          row.id,
          workerId,
          resolved.provider,
          resolved.mode,
          resolved.modelName ?? null,
          resolved.reasoningEffort ?? null,
          reuseSource?.session_id ?? null,
          reuseSource?.id ?? null,
          reuseSource?.repo_path ?? null,
          reuseSource?.worktree_path ?? null,
          reuseSource?.branch_name ?? null,
          reuseSource?.base_branch ?? null,
          reuseFallbackReason,
          requested.provider,
          requested.mode,
          requested.modelName ?? null,
          requested.reasoningEffort ?? null,
          requestedBaseBranch ?? null,
        ],
      );
      await client.query("COMMIT");
      return { row: updated.rows[0], resolved, requested, requestedBaseBranch };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.removeListener("error", onClientError);
      client.release(clientError);
    }
  }

  private claimProviderExpression(): string {
    const configuredProvider = `'${
      this.config.agentProvider === "both" ? this.config.defaultAgentProvider : this.config.agentProvider
    }'`;
    const requestedProvider =
      this.config.agentProvider === "both"
        ? `CASE
            WHEN COALESCE(candidate.requested_agent_provider, candidate.agent_provider) IN ('codex', 'claude')
              THEN COALESCE(candidate.requested_agent_provider, candidate.agent_provider)
            ELSE ${configuredProvider}
          END`
        : configuredProvider;

    return `CASE
      WHEN candidate.session_id IS NOT NULL THEN
        CASE
          WHEN candidate.agent_provider IN ('codex', 'claude') THEN candidate.agent_provider
          ELSE ${requestedProvider}
        END
      WHEN candidate.reuse_session THEN COALESCE(
        (
          SELECT CASE
                   WHEN prior.agent_provider IN ('codex', 'claude') THEN prior.agent_provider
                 END
          FROM ${this.table} AS prior
          WHERE prior.uid = candidate.uid
            AND prior.status = 'succeeded'
            AND prior.session_id IS NOT NULL
            AND prior.repo_path IS NOT NULL
            AND prior.worktree_path IS NOT NULL
            AND prior.worktree_removed_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${this.table} AS active
              WHERE active.session_id = prior.session_id
                AND active.status IN ('queued', 'retry', 'running')
            )
          ORDER BY prior.finished_at DESC NULLS LAST, prior.id DESC
          LIMIT 1
        ),
        ${requestedProvider}
      )
      ELSE ${requestedProvider}
    END`;
  }

  async abandonSessionReuse(
    id: number,
    workerId: string,
    requested: ClaimedRun["requested"],
    requestedBaseBranch: string | null | undefined,
    reason: string,
  ): Promise<AgentRunRow> {
    const result = await this.pool.query<AgentRunRow>(
      `UPDATE ${this.table}
       SET agent_provider = $3,
           agent_mode = $4,
           model_name = $5,
           reasoning_effort = $6,
           session_id = NULL,
           reused_from_run_id = NULL,
           repo_path = NULL,
           worktree_path = NULL,
           branch_name = NULL,
           base_branch = $7,
           setup_logs = NULL,
           cleanup_note = NULL,
           worktree_removed_at = NULL,
           reuse_fallback_reason = $8,
           updated_at = NOW()
       WHERE id = $1 AND locked_by = $2 AND status = 'running'
       RETURNING *`,
      [
        id,
        workerId,
        requested.provider,
        requested.mode,
        requested.modelName ?? null,
        requested.reasoningEffort ?? null,
        requestedBaseBranch ?? null,
        reason,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`run ${id} was no longer owned by ${workerId} while abandoning session reuse`);
    }
    return row;
  }

  async requestCancellation(id: number): Promise<CancellationRequestResult> {
    const requested = await this.pool.query<{ locked_by: string | null }>(
      `UPDATE ${this.table}
       SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING locked_by`,
      [id],
    );
    if (requested.rows[0]) {
      return { outcome: "requested", lockedBy: requested.rows[0].locked_by };
    }

    const existing = await this.pool.query<{ status: string }>(`SELECT status FROM ${this.table} WHERE id = $1`, [id]);
    return existing.rows[0] ? { outcome: "not-running" } : { outcome: "not-found" };
  }

  async retryFailedRun(id: number): Promise<RetryRequestOutcome> {
    const retried = await this.pool.query(
      `UPDATE ${this.table}
       SET status = 'retry',
           num_retries = GREATEST(COALESCE(num_retries, 0), COALESCE(attempts, 0)),
           finished_at = NULL,
           updated_at = NOW(),
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL,
           cancel_requested_at = NULL
       WHERE id = $1 AND status = 'failed'
       RETURNING id`,
      [id],
    );
    if (retried.rows[0]) {
      return "queued";
    }

    const existing = await this.pool.query<{ status: string }>(`SELECT status FROM ${this.table} WHERE id = $1`, [id]);
    return existing.rows[0] ? "not-failed" : "not-found";
  }

  async isCancellationRequested(id: number, workerId: string): Promise<boolean> {
    const result = await this.pool.query<{ requested: boolean }>(
      `SELECT cancel_requested_at IS NOT NULL AS requested
       FROM ${this.table}
       WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [id, workerId],
    );
    return result.rows[0]?.requested ?? false;
  }

  async heartbeat(id: number, workerId: string): Promise<boolean> {
    const result = await this.pool.query<{ cancel_requested: boolean }>(
      `UPDATE ${this.table}
       SET heartbeat_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND locked_by = $2 AND status = 'running'
       RETURNING cancel_requested_at IS NOT NULL AS cancel_requested`,
      [id, workerId],
    );
    return result.rows[0]?.cancel_requested ?? false;
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
           worktree_removed_at = NULL,
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

  async markSucceeded(id: number, workerId: string, result: ExecutionResult): Promise<boolean> {
    const updated = await this.pool.query(
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
           session_id = COALESCE($9, session_id),
           setup_logs = COALESCE($10, setup_logs),
           cleanup_note = COALESCE($11, cleanup_note),
           error = NULL,
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'running' AND cancel_requested_at IS NULL`,
      [
        id,
        workerId,
        result.link ?? null,
        result.lastMessage ?? null,
        JSON.stringify(result.conversation ?? null),
        result.logs,
        JSON.stringify(result.result ?? null),
        result.exitCode,
        result.sessionId ?? null,
        result.workspace?.setupLogs ?? null,
        result.workspace?.cleanupNote ?? null,
      ],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async markFailed(id: number, workerId: string, run: AgentRunRow, error: unknown, result?: ExecutionResult): Promise<boolean> {
    const attempts = run.attempts ?? 1;
    const retries = run.num_retries ?? 0;
    const shouldRetry = attempts <= retries;
    const updated = await this.pool.query(
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
           session_id = COALESCE($10, session_id),
           error = $11::jsonb,
           setup_logs = COALESCE($12, setup_logs),
           cleanup_note = COALESCE($13, cleanup_note),
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'running' AND cancel_requested_at IS NULL`,
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
        result?.sessionId ?? null,
        JSON.stringify(errorToJson(error)),
        result?.workspace?.setupLogs ?? null,
        result?.workspace?.cleanupNote ?? null,
      ],
    );
    return (updated.rowCount ?? 0) > 0;
  }

  async markCancelled(id: number, workerId: string, result?: ExecutionResult): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE ${this.table}
       SET status = 'cancelled',
           finished_at = NOW(),
           updated_at = NOW(),
           link = COALESCE($3, link),
           last_message = COALESCE($4, last_message),
           conversation = COALESCE($5::jsonb, conversation),
           logs = COALESCE($6, logs),
           result = COALESCE($7::jsonb, result),
           exit_code = COALESCE($8, exit_code, 1),
           session_id = COALESCE($9, session_id),
           error = $10::jsonb,
           setup_logs = COALESCE($11, setup_logs),
           cleanup_note = COALESCE($12, cleanup_note),
           cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           locked_by = NULL,
           locked_at = NULL,
           heartbeat_at = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [
        id,
        workerId,
        result?.link ?? null,
        result?.lastMessage ?? null,
        result?.conversation === undefined ? null : JSON.stringify(result.conversation),
        result?.logs ?? null,
        result?.result === undefined ? null : JSON.stringify(result.result),
        result?.exitCode ?? null,
        result?.sessionId ?? null,
        JSON.stringify({ message: "cancelled by user" }),
        result?.workspace?.setupLogs ?? null,
        result?.workspace?.cleanupNote ?? null,
      ],
    );
    return (updated.rowCount ?? 0) > 0;
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

  private async withLocalCleanupLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.localCleanupLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.localCleanupLocks.set(key, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.localCleanupLocks.get(key) === tail) {
        this.localCleanupLocks.delete(key);
      }
    }
  }

  private resolvePersistedSessionConfig(row: AgentRunRow): ClaimedRun["resolved"] {
    if (!row.agent_provider) {
      throw new Error("reusable session is missing agent_provider");
    }
    const provider = parseAgentProvider(row.agent_provider);
    const mode = parseAgentMode(row.agent_mode ?? "exec");
    return {
      provider,
      mode,
      modelName: row.model_name ?? undefined,
      reasoningEffort: row.reasoning_effort ?? undefined,
    };
  }

  private resolvePersistedRequestedConfig(row: AgentRunRow): ClaimedRun["requested"] {
    if (!row.requested_agent_provider) {
      throw new Error("persisted requested configuration is missing agent_provider");
    }
    const provider = parseAgentProvider(row.requested_agent_provider);
    const mode = parseAgentMode(row.requested_agent_mode ?? "exec");
    return {
      provider,
      mode,
      modelName: row.requested_model_name ?? undefined,
      reasoningEffort: row.requested_reasoning_effort ?? undefined,
    };
  }
}

function worktreeCleanupLockName(repoRoot: string): string {
  return `agentrunner:worktree-cleanup:${repoRoot}`;
}

export function errorToJson(error: unknown): Record<string, unknown> {
  const serialized = serializeErrorValue(error, new Set());
  if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
    return serialized as Record<string, unknown>;
  }
  return { message: String(serialized) };
}

function serializeErrorValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeErrorValue(item, seen));
  }

  const output: Record<string, unknown> = {};
  const isError = value instanceof Error;
  if (isError) {
    output.message = value.message;
    output.name = value.name;
    output.stack = value.stack;
  }
  for (const key of new Set([...Object.getOwnPropertyNames(value), ...Object.keys(value)])) {
    if (isError && (key === "message" || key === "name" || key === "stack")) {
      continue;
    }
    try {
      output[key] = serializeErrorValue((value as Record<string, unknown>)[key], seen);
    } catch {
      output[key] = "[Unserializable]";
    }
  }
  return output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
