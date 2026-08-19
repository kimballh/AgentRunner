import { describe, expect, test } from "vitest";
import { AgentRunnerService } from "./service.js";
import type { AgentProviderMode, ServiceConfig } from "./types.js";

describe("AgentRunnerService worker capacity", () => {
  test("treats numWorkers as a per-provider limit when both providers are enabled", async () => {
    const service = new AgentRunnerService(serviceConfig("both", 4));

    expect(service.stats()).toMatchObject({ active: 0, maxWorkers: 8, availableWorkers: 8 });

    await service.stop();
  });

  test("keeps numWorkers as the total when only one provider is enabled", async () => {
    const service = new AgentRunnerService(serviceConfig("claude", 4));

    expect(service.stats()).toMatchObject({ active: 0, maxWorkers: 4, availableWorkers: 4 });

    await service.stop();
  });
});

function serviceConfig(agentProvider: AgentProviderMode, numWorkers: number): ServiceConfig {
  return {
    cwd: "/tmp",
    configPath: "/tmp/agentrunner_config.toml",
    databaseUrl: "postgres://unused/unused",
    databaseUrlEnvVar: "AGENTRUNNER_DATABASE_URL",
    databaseSchema: "public",
    databaseTable: "agent_runs",
    agentProvider,
    defaultAgentProvider: "codex",
    agentMode: "exec",
    numWorkers,
    pollFrequencyMs: 60_000,
    staleAfterMs: 900_000,
    preflightRetries: 2,
    preflightRetryDelayMs: 1_000,
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
