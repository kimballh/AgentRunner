import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ServiceConfig } from "../types.js";
import { cursorSessionId, runCursor } from "./cursor.js";

describe("cursor executor", () => {
  test("extracts Cursor session identifiers", () => {
    expect(cursorSessionId({ session_id: "cursor-session" })).toBe("cursor-session");
    expect(cursorSessionId({ chatId: "cursor-chat" })).toBe("cursor-chat");
  });

  test("runs Cursor in safe headless mode and resumes a saved chat", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-cursor-resume-test-"));
    const fakeCursorBin = path.join(tempDir, "fake-cursor-resume.js");
    await fs.writeFile(
      fakeCursorBin,
      `#!/usr/bin/env node
process.stderr.write(JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ chatId: "cursor-chat", result: "done" }));
`,
      { mode: 0o755 },
    );

    try {
      const result = await runCursor({
        prompt: "test again",
        cwd: tempDir,
        sessionId: "cursor-chat",
        resolved: { provider: "cursor", mode: "exec", modelName: "composer" },
        config: testConfig(fakeCursorBin, tempDir),
      });

      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("cursor-chat");
      expect(result.lastMessage).toBe("done");
      expect(result.logs).toContain('"--resume","cursor-chat"');
      expect(result.logs).toContain('"--sandbox","enabled"');
      expect(result.logs).not.toContain('"--force"');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function testConfig(cursorBin: string, cwd: string): ServiceConfig {
  return {
    cwd,
    configPath: path.join(cwd, "agentrunner_config.toml"),
    databaseUrl: "",
    databaseUrlEnvVar: "AGENTRUNNER_DATABASE_URL",
    databaseSchema: "public",
    databaseTable: "agent_runs",
    agentProvider: "cursor",
    defaultAgentProvider: "cursor",
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
      deleteDirtyWorktrees: false,
      setup: "never",
      setupCommand: [],
    },
    codex: { bin: "codex", bypassApprovalsAndSandbox: true, extraArgs: [], appServerExtraArgs: [], config: [] },
    claude: { bin: "claude", extraArgs: [] },
    cursor: { bin: cursorBin, mode: "agent", sandbox: "enabled", force: false, extraArgs: [] },
  };
}
