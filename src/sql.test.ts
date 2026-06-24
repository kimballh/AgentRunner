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
    expect(sql).toContain("agent_runs_status_priority_idx");
  });

  test("prints force drop SQL for configured table only", () => {
    expect(dropTableSql({ databaseSchema: "custom", databaseTable: "runs" })).toBe(
      'DROP TABLE IF EXISTS "custom"."runs" CASCADE;',
    );
  });
});
