import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ServiceConfig } from "../types.js";
import { parseExecThreadId, runCodex, threadUrl } from "./codex.js";

describe("codex executor helpers", () => {
  test("extracts thread id from codex JSONL", () => {
    const stdout = ['{"type":"noise"}', '{"type":"thread.started","thread_id":"019-thread"}'].join("\n");
    expect(parseExecThreadId(stdout)).toBe("019-thread");
  });

  test("builds codex thread URLs", () => {
    expect(threadUrl("thread with spaces")).toBe("codex://threads/thread%20with%20spaces");
  });

  test("stops long-lived app-server after turn completion", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-codex-test-"));
    const fakeCodexBin = path.join(tempDir, "fake-codex-app-server.js");
    await fs.writeFile(
      fakeCodexBin,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";

process.stderr.write("fake app-server ready\\n");

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "thread/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "fake-thread" } } }) + "\\n");
  } else if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "done" } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n");
  }
});

process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1000);
`,
      { mode: 0o755 },
    );

    try {
      const result = await runCodex({
        prompt: "finish",
        cwd: tempDir,
        resolved: { provider: "codex", mode: "app-server" },
        config: testConfig(fakeCodexBin, tempDir),
      });

      expect(result.exitCode).toBe(0);
      expect(result.link).toBe("codex://threads/fake-thread");
      expect(result.lastMessage).toBe("done");
      expect(result.logs).toContain("fake app-server ready");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function testConfig(codexBin: string, cwd: string): ServiceConfig {
  return {
    cwd,
    configPath: path.join(cwd, "agentrunner_config.toml"),
    databaseUrl: "",
    databaseUrlEnvVar: "AGENTRUNNER_DATABASE_URL",
    databaseSchema: "public",
    databaseTable: "agent_runs",
    agentProvider: "codex",
    defaultAgentProvider: "codex",
    agentMode: "app-server",
    numWorkers: 1,
    pollFrequencyMs: 1000,
    staleAfterMs: 15_000,
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
    codex: {
      bin: codexBin,
      bypassApprovalsAndSandbox: true,
      extraArgs: [],
      appServerExtraArgs: [],
      config: [],
    },
    claude: {
      bin: "claude",
      extraArgs: [],
    },
  };
}
