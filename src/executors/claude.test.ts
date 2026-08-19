import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ServiceConfig } from "../types.js";
import { runClaude, sessionIdFrom } from "./claude.js";

describe("claude executor", () => {
  test("extracts Claude session ids", () => {
    expect(sessionIdFrom({ session_id: "claude-session" })).toBe("claude-session");
    expect(sessionIdFrom({ sessionId: "camel-session" })).toBe("camel-session");
  });

  test("resumes a saved Claude session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-claude-resume-test-"));
    const fakeClaudeBin = path.join(tempDir, "fake-claude-resume.js");
    await fs.writeFile(
      fakeClaudeBin,
      `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ session_id: "claude-session", result: "done" }));
`,
      { mode: 0o755 },
    );

    try {
      const result = await runClaude({
        prompt: "test again",
        cwd: tempDir,
        sessionId: "claude-session",
        resolved: { provider: "claude", mode: "exec", modelName: "claude-opus-5" },
        config: testConfig(fakeClaudeBin, tempDir),
      });

      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("claude-session");
      expect(result.logs).toContain('"--resume","claude-session"');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function testConfig(claudeBin: string, cwd: string): ServiceConfig {
  return {
    cwd,
    configPath: path.join(cwd, "agentrunner_config.toml"),
    databaseUrl: "",
    databaseUrlEnvVar: "AGENTRUNNER_DATABASE_URL",
    databaseSchema: "public",
    databaseTable: "agent_runs",
    agentProvider: "claude",
    defaultAgentProvider: "claude",
    agentMode: "exec",
    numWorkers: 1,
    pollFrequencyMs: 1000,
    staleAfterMs: 15_000,
    preflightRetries: 2,
    preflightRetryDelayMs: 0,
    host: "127.0.0.1",
    port: 0,
    git: {
      createWorktrees: "never",
      remote: "origin",
      branchPrefix: "agentrunner",
      worktreeDir: ".worktrees",
      maxWorktrees: 0,
      cleanupBatchSize: 1,
      cleanupDeleteBranches: false,
      setup: "never",
      setupCommand: [],
    },
    codex: { bin: "codex", bypassApprovalsAndSandbox: true, extraArgs: [], appServerExtraArgs: [], config: [] },
    claude: { bin: claudeBin, extraArgs: [] },
  };
}
