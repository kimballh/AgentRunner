import { describe, expect, test } from "vitest";
import { dropTableSql, migrationSql, quoteIdentifier } from "./sql.js";

describe("sql helpers", () => {
  test("rejects invalid SQL identifiers", () => {
    expect(() => quoteIdentifier("public;drop")).toThrow("Invalid SQL identifier");
  });

  test("prints operational columns", () => {
    const sql = migrationSql({ databaseSchema: "public", databaseTable: "agent_runs" });
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS locked_by text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS worktree_path text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS worktree_removed_at timestamp");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS reuse_session boolean not null default false");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS session_id text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS reused_from_run_id integer");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS reuse_fallback_reason text");
    expect(sql).toContain("agent_runs_reusable_uid_idx");
    expect(sql).toContain("agent_runs_active_session_idx");
    expect(sql).toContain("agent_runs_status_priority_idx");
    expect(sql).toContain("agent_runs_created_at_id_idx");
    expect(sql).toContain("agent_runs_pending_worktree_cleanup_idx");
    expect(sql).toContain("INCLUDE (worktree_path, branch_name, status)");
    expect(sql).toContain("worktree_removed_at IS NULL");
  });

  test("prints force drop SQL for configured table only", () => {
    expect(dropTableSql({ databaseSchema: "custom", databaseTable: "runs" })).toBe(
      'DROP TABLE IF EXISTS "custom"."runs" CASCADE;',
    );
  });
});
