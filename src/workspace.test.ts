import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { prepareWorkspace, runWorkspaceSetup, type WorkspaceCommandRunner } from "./workspace.js";
import type { AgentRunRow, CompletedRunForCleanup, ServiceConfig } from "./types.js";

describe("workspace", () => {
  test("auto mode falls back to cwd outside git", async () => {
    const cwd = await tempDir();
    const workspace = await prepareWorkspace({
      config: serviceConfig({ cwd }),
      run: row(),
      completedRuns: [],
    });

    expect(workspace.cwd).toBe(cwd);
    expect(workspace.worktreePath).toBeUndefined();
  });

  test("configured repo creates a worktree from the configured base branch", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const runner = recordingRunner();

    const workspace = await prepareWorkspace({
      config: serviceConfig({
        cwd,
        git: {
          ...gitConfig(),
          repo,
          baseBranch: "origin/main",
          worktreeDir: ".worktrees",
          maxWorktrees: 25,
        },
      }),
      run: row({ id: 42, uid: "HAR-42" }),
      completedRuns: [],
      runner,
    });

    expect(workspace.repoPath).toBe(repo);
    expect(workspace.baseBranch).toBe("origin/main");
    expect(workspace.branchName).toMatch(/^agentrunner\/har-42-42-/);
    expect(runner.commands.map((item) => item.command.join(" "))).toContain("git fetch origin");
    expect(runner.commands.some((item) => item.command.includes("worktree"))).toBe(true);
  });

  test("missing upstream branch produces a clear error", async () => {
    const cwd = await tempDir();
    const runner = recordingRunner({ defaultStdout: "" });

    await expect(
      prepareWorkspace({
        config: serviceConfig({ cwd, git: { ...gitConfig(), repo: cwd, baseBranch: undefined } }),
        run: row(),
        completedRuns: [],
        runner,
      }),
    ).rejects.toThrow("No upstream branch found");
  });

  test("cleanup removes oldest clean completed worktree before creating a new one", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const root = path.join(repo, ".worktrees");
    const old = path.join(root, "old");
    await fs.mkdir(old, { recursive: true });
    const runner = recordingRunner();

    await prepareWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo, maxWorktrees: 1, cleanupBatchSize: 1 } }),
      run: row(),
      completedRuns: [row({ id: 1, worktree_path: old, branch_name: "agentrunner/old", status: "succeeded" })],
      runner,
    });

    expect(runner.commands.map((item) => item.command.join(" "))).toContain(`git worktree remove ${old}`);
  });

  test("cleanup reads past 100 missing paths and persists reconciliation state", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const root = path.join(repo, ".worktrees");
    const oldOne = path.join(root, "old-one");
    const oldTwo = path.join(root, "old-two");
    await fs.mkdir(oldOne, { recursive: true });
    await fs.mkdir(oldTwo, { recursive: true });
    const runner = recordingRunner();
    const marked: Array<{ id: number; note: string }> = [];
    let pagesRead = 0;

    async function* completedRuns(): AsyncGenerator<CompletedRunForCleanup> {
      pagesRead++;
      for (let id = 1; id <= 100; id++) {
        yield cleanupRow(id, path.join(root, `already-removed-${id}`));
      }
      pagesRead++;
      yield cleanupRow(101, oldOne);
      yield cleanupRow(102, oldTwo);
    }

    await prepareWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo, maxWorktrees: 2, cleanupBatchSize: 1 } }),
      run: row(),
      completedRuns: completedRuns(),
      onWorktreeRemoved: async (id, note) => {
        marked.push({ id, note });
      },
      runner,
    });

    expect(pagesRead).toBe(2);
    expect(marked.filter(({ note }) => note.includes("already absent"))).toHaveLength(100);
    expect(marked).toContainEqual({ id: 101, note: "worktree removed by cleanup" });
    expect(runner.commands.map((item) => item.command.join(" "))).toContain(`git worktree remove ${oldOne}`);
  });

  test("cleanup reconciles stale registered AgentRunner worktrees missing from the database", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const root = path.join(repo, ".worktrees");
    const legacy = path.join(root, "legacy");
    await fs.mkdir(legacy, { recursive: true });
    const oldTimestamp = new Date(Date.now() - 60_000);
    await fs.utimes(legacy, oldTimestamp, oldTimestamp);
    const runner = recordingRunner({
      worktreeList: [
        `worktree ${repo}`,
        "branch refs/heads/main",
        "",
        `worktree ${legacy}`,
        "branch refs/heads/agentrunner/legacy",
        "",
      ].join("\n"),
    });

    await prepareWorkspace({
      config: serviceConfig({
        cwd,
        staleAfterMs: 1_000,
        git: { ...gitConfig(), repo, maxWorktrees: 1, cleanupBatchSize: 1 },
      }),
      run: row(),
      completedRuns: [],
      recordedWorktreePaths: [],
      runner,
    });

    expect(runner.commands.map((item) => item.command.join(" "))).toContain(`git worktree remove ${legacy}`);
  });

  test("auto setup uses .codex environment script when present", async () => {
    const cwd = await tempDir();
    await fs.mkdir(path.join(cwd, ".codex", "environments"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".codex", "environments", "environment.toml"),
      ['[setup]', 'script = "echo setup-ran"'].join("\n"),
    );

    const logs = await runWorkspaceSetup(serviceConfig({ cwd }), { cwd, worktreePath: cwd });

    expect(logs).toContain("setup-ran");
  });
});

function recordingRunner(options: { defaultStdout?: string; worktreeList?: string } = {}): WorkspaceCommandRunner & {
  commands: Array<{ command: string[]; cwd: string; label: string }>;
} {
  const commands: Array<{ command: string[]; cwd: string; label: string }> = [];
  return {
    commands,
    async run(command, runOptions) {
      commands.push({ command, cwd: runOptions.cwd, label: runOptions.label });
      if (command.join(" ") === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { exitCode: 0, stdout: options.defaultStdout ?? "origin/main\n", stderr: "" };
      }
      if (command.join(" ") === "git worktree list --porcelain") {
        return { exitCode: 0, stdout: options.worktreeList ?? "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function cleanupRow(id: number, worktreePath: string): CompletedRunForCleanup {
  const completedAt = new Date(id * 1_000);
  return {
    id,
    created_at: completedAt,
    finished_at: completedAt,
    cleanup_at: completedAt,
    worktree_path: worktreePath,
    branch_name: `agentrunner/run-${id}`,
  };
}

function serviceConfig(overrides: Partial<ServiceConfig>): ServiceConfig {
  return {
    cwd: "/tmp",
    configPath: "/tmp/agentrunner_config.toml",
    databaseUrl: "postgres://localhost/db",
    databaseUrlEnvVar: "AGENTRUNNER_DATABASE_URL",
    databaseSchema: "public",
    databaseTable: "agent_runs",
    agentProvider: "both",
    defaultAgentProvider: "codex",
    agentMode: "exec",
    numWorkers: 1,
    pollFrequencyMs: 60_000,
    staleAfterMs: 900_000,
    host: "127.0.0.1",
    port: 0,
    git: gitConfig(),
    codex: { bin: "codex", bypassApprovalsAndSandbox: true, extraArgs: [], appServerExtraArgs: [], config: [] },
    claude: { bin: "claude", extraArgs: [] },
    ...overrides,
  };
}

function gitConfig(): ServiceConfig["git"] {
  return {
    createWorktrees: "auto",
    remote: "origin",
    branchPrefix: "agentrunner",
    worktreeDir: ".worktrees",
    maxWorktrees: 25,
    cleanupBatchSize: 5,
    cleanupDeleteBranches: false,
    setup: "auto",
    setupCommand: [],
  };
}

function row(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 1,
    status: "queued",
    raw_webhook_data: {},
    prompt: "hello",
    uid: "uid",
    created_at: new Date(),
    finished_at: null,
    link: null,
    last_message: null,
    conversation: null,
    attempts: null,
    logs: null,
    priority: 0,
    error: null,
    model_name: null,
    reasoning_effort: null,
    agent_provider: null,
    agent_mode: null,
    num_retries: null,
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-workspace-"));
}
