import type { ServiceConfig } from "./types.js";

export function qualifiedTable(config: Pick<ServiceConfig, "databaseSchema" | "databaseTable">): string {
  return `${quoteIdentifier(config.databaseSchema)}.${quoteIdentifier(config.databaseTable)}`;
}

export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function baseTableSql(config: Pick<ServiceConfig, "databaseSchema" | "databaseTable">): string {
  const schema = quoteIdentifier(config.databaseSchema);
  const table = qualifiedTable(config);
  return `CREATE SCHEMA IF NOT EXISTS ${schema};

CREATE TABLE IF NOT EXISTS ${table}
(
    id               integer generated always as identity
        primary key,
    status           text      not null,
    raw_webhook_data jsonb     not null,
    prompt           text      not null,
    uid              text      not null,
    created_at       timestamp not null,
    finished_at      timestamp,
    link             text,
    last_message     text,
    conversation     jsonb,
    attempts         integer,
    logs             text,
    priority         integer   not null,
    error            jsonb,
    model_name       text,
    reasoning_effort text,
    agent_provider   text,
    agent_mode       text,
    num_retries      integer
);

CREATE INDEX IF NOT EXISTS index_uid
    ON ${table} (id, uid);`;
}

export function migrationSql(config: Pick<ServiceConfig, "databaseSchema" | "databaseTable">): string {
  const schema = quoteIdentifier(config.databaseSchema);
  const table = qualifiedTable(config);
  return `${baseTableSql(config)}

ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS started_at timestamp;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_at timestamp not null default now();
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS locked_by text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS locked_at timestamp;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS heartbeat_at timestamp;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS exit_code integer;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS repo_path text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS worktree_path text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS workspace_mode text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS branch_name text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS base_branch text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS setup_logs text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cleanup_note text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS worktree_removed_at timestamp;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS reuse_session boolean not null default false;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS reused_from_run_id integer;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS reuse_fallback_reason text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS requested_agent_provider text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS requested_agent_mode text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS requested_model_name text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS requested_reasoning_effort text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS requested_base_branch text;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS cancel_requested_at timestamp;

CREATE INDEX IF NOT EXISTS agent_runs_status_priority_idx
    ON ${table} (status, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS agent_runs_created_at_id_idx
    ON ${table} (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS agent_runs_reusable_uid_idx
    ON ${table} (uid, finished_at DESC, id DESC)
    WHERE status = 'succeeded'
      AND session_id IS NOT NULL
      AND worktree_path IS NOT NULL
      AND worktree_removed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_active_session_idx
    ON ${table} (session_id)
    WHERE session_id IS NOT NULL
      AND status IN ('queued', 'retry', 'running');

DROP INDEX IF EXISTS ${schema}.agent_runs_completed_worktree_cleanup_idx;
DROP INDEX IF EXISTS ${schema}.agent_runs_pending_worktree_cleanup_idx;
CREATE INDEX IF NOT EXISTS agent_runs_pending_worktree_cleanup_idx
    ON ${table} ((COALESCE(finished_at, updated_at, created_at)), id)
    INCLUDE (worktree_path, branch_name, status)
    WHERE worktree_path IS NOT NULL
      AND worktree_removed_at IS NULL
      AND status IN ('succeeded', 'failed', 'cancelled');

CREATE INDEX IF NOT EXISTS agent_runs_locked_at_idx
    ON ${table} (locked_at);`;
}

export function dropTableSql(config: Pick<ServiceConfig, "databaseSchema" | "databaseTable">): string {
  return `DROP TABLE IF EXISTS ${qualifiedTable(config)} CASCADE;`;
}
