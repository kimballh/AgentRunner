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
