import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgentRunStore } from "./store.js";
import type { ServiceConfig } from "./types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;
const schema = `agentrunner_test_${Date.now()}`;
let pool: Pool;
let store: AgentRunStore;
let config: ServiceConfig;

maybeDescribe("AgentRunStore integration", () => {
  beforeAll(async () => {
    config = serviceConfig(databaseUrl!, schema);
    pool = new Pool({ connectionString: databaseUrl });
    store = new AgentRunStore(config);
    await store.setup();
  });

  afterAll(async () => {
    await store?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  test("claims by priority and updates success", async () => {
    await pool.query(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, priority, agent_provider)
       VALUES
       ('queued', '{}'::jsonb, 'low', 'low', NOW(), 1, 'codex'),
       ('queued', '{}'::jsonb, 'high', 'high', NOW(), 10, 'claude')`,
    );

    const claimed = await store.claimNext("worker-1");
    expect(claimed?.row.uid).toBe("high");
    expect(claimed?.resolved.provider).toBe("claude");

    await store.markSucceeded(claimed!.row.id, "worker-1", {
      exitCode: 0,
      lastMessage: "done",
      logs: "logs",
      result: { ok: true },
    });

    const updated = await store.getRun(claimed!.row.id);
    expect(updated?.status).toBe("succeeded");
    expect(updated?.last_message).toBe("done");
  });

  test("returns all narrow cleanup candidates and excludes persisted removals", async () => {
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO "${schema}"."agent_runs"
       (status, raw_webhook_data, prompt, uid, created_at, finished_at, priority, worktree_path)
       SELECT 'succeeded', '{}'::jsonb, 'cleanup', 'cleanup-' || value, NOW(), NOW(), 0, '/tmp/worktree-' || value
       FROM generate_series(1, 105) AS value
       RETURNING id`,
    );
    await store.markWorktreeRemoved(inserted.rows[0].id, "removed in test");

    const candidateRows = await store.completedRunsOldestFirst();
    const candidates = candidateRows.map((run) => run.id);

    expect(candidates).toHaveLength(104);
    expect(candidates).not.toContain(inserted.rows[0].id);
    expect(candidateRows.every((run) => run.status === "succeeded")).toBe(true);
    expect(Object.keys(candidateRows[0]).sort()).toEqual(["branch_name", "id", "status", "worktree_path"]);
    const removed = await store.getRun(inserted.rows[0].id);
    expect(removed?.worktree_removed_at).toBeInstanceOf(Date);
  });

  test("serializes cleanup locks across store instances", async () => {
    const secondStore = new AgentRunStore(config);
    let active = 0;
    let maxActive = 0;
    const operation = async (): Promise<void> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
    };

    try {
      await Promise.all([
        store.withWorktreeCleanupLock("/tmp/shared-repo", operation),
        secondStore.withWorktreeCleanupLock("/tmp/shared-repo", operation),
      ]);
    } finally {
      await secondStore.close();
    }

    expect(maxActive).toBe(1);
  });
});

function serviceConfig(url: string, databaseSchema: string): ServiceConfig {
  return {
    cwd: "/tmp",
    configPath: "/tmp/agentrunner_config.toml",
    databaseUrl: url,
    databaseUrlEnvVar: "TEST_DATABASE_URL",
    databaseSchema,
    databaseTable: "agent_runs",
    agentProvider: "both",
    defaultAgentProvider: "codex",
    agentMode: "exec",
    numWorkers: 1,
    pollFrequencyMs: 60_000,
    staleAfterMs: 900_000,
    preflightRetries: 2,
    preflightRetryDelayMs: 0,
    host: "127.0.0.1",
    port: 0,
    git: {
      createWorktrees: "auto",
      remote: "origin",
      branchPrefix: "agentrunner",
      worktreeDir: ".worktrees",
      maxWorktrees: 25,
      cleanupBatchSize: 5,
      cleanupDeleteBranches: false,
      setup: "auto",
      setupCommand: [],
    },
    codex: { bin: "codex", bypassApprovalsAndSandbox: true, extraArgs: [], appServerExtraArgs: [], config: [] },
    claude: { bin: "claude", extraArgs: [] },
  };
}
