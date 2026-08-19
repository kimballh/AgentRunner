import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { CommandError } from "./process.js";
import {
  prepareReusedWorkspace,
  prepareWorkspace,
  runWorkspaceSetup,
  type WorkspaceCommandRunner,
} from "./workspace.js";
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
    const commands = runner.commands.map((item) => item.command.join(" "));
    expect(commands.findIndex((command) => command === "git fetch origin")).toBeLessThan(
      commands.findIndex((command) => command.startsWith("git worktree add ")),
    );
  });

  test("queued base branch overrides the configured base after fetching its remote", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const runner = recordingRunner();

    const workspace = await prepareWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo, baseBranch: "origin/main" } }),
      run: row({ id: 72, uid: "HAR-72", base_branch: "origin/project/workflow-automation" }),
      completedRuns: [],
      runner,
    });

    expect(workspace.baseBranch).toBe("origin/project/workflow-automation");
    expect(runner.commands.map((item) => item.command.join(" "))).toEqual(
      expect.arrayContaining([
        "git fetch origin",
        expect.stringMatching(
          /^git worktree add -b agentrunner\/har-72-72-[a-zA-Z0-9]+ .* origin\/project\/workflow-automation$/,
        ),
      ]),
    );
  });

  test("blank queued base branch falls back to the configured base branch", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const runner = recordingRunner();

    const workspace = await prepareWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo, baseBranch: "origin/main" } }),
      run: row({ base_branch: "  " }),
      completedRuns: [],
      runner,
    });

    expect(workspace.baseBranch).toBe("origin/main");
  });

  test("retries a transient Git fetch failure before creating the worktree", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const runner = recordingRunner({ transientFetchFailures: 2 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await prepareWorkspace({
        config: serviceConfig({ cwd, git: { ...gitConfig(), repo, baseBranch: "origin/main" } }),
        run: row(),
        completedRuns: [],
        runner,
      });
    } finally {
      warn.mockRestore();
    }

    expect(runner.commands.filter((item) => item.command.join(" ") === "git fetch origin")).toHaveLength(3);
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

  test("serialized cleanup reloads candidates after acquiring the lock", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const root = path.join(repo, ".worktrees");
    const oldOne = path.join(root, "old-one");
    const oldTwo = path.join(root, "old-two");
    await fs.mkdir(oldOne, { recursive: true });
    await fs.mkdir(oldTwo, { recursive: true });
    const runner = recordingRunner();
    const runCommand = runner.run.bind(runner);
    runner.run = async (command, options) => {
      const result = await runCommand(command, options);
      if (command[0] === "git" && command[1] === "worktree" && command[2] === "remove") {
        await fs.rm(command[3]!, { recursive: true });
      }
      return result;
    };

    const remaining = new Map([
      [1, cleanupRow(1, oldOne)],
      [2, cleanupRow(2, oldTwo)],
    ]);
    let lockTail = Promise.resolve();
    let activeLocks = 0;
    let maxActiveLocks = 0;
    async function withCleanupLock<T>(_repoRoot: string, operation: () => Promise<T>): Promise<T> {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      activeLocks++;
      maxActiveLocks = Math.max(maxActiveLocks, activeLocks);
      try {
        return await operation();
      } finally {
        activeLocks--;
        release();
      }
    }
    const input = (runId: number) => ({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo, maxWorktrees: 1, cleanupBatchSize: 1 } }),
      run: row({ id: runId, uid: `HAR-${runId}` }),
      completedRuns: [],
      loadCleanupState: async () => ({
        completedRuns: [...remaining.values()],
        recordedWorktreePaths: [...remaining.values()].map((run) => run.worktree_path!),
      }),
      withCleanupLock,
      onWorktreeRemoved: async (id: number) => {
        remaining.delete(id);
      },
      runner,
    });

    await Promise.all([prepareWorkspace(input(100)), prepareWorkspace(input(101))]);

    expect(maxActiveLocks).toBe(1);
    expect(remaining.size).toBe(0);
    expect(
      runner.commands
        .filter((item) => item.command.slice(0, 3).join(" ") === "git worktree remove")
        .map((item) => item.command[3]),
    ).toEqual([oldOne, oldTwo]);
  });

  test("cleanup reconciles a candidate removed concurrently after the path check", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const root = path.join(repo, ".worktrees");
    const old = path.join(root, "old");
    await fs.mkdir(old, { recursive: true });
    const runner = recordingRunner();
    const runCommand = runner.run.bind(runner);
    runner.run = async (command, options) => {
      const result = await runCommand(command, options);
      if (command.join(" ") === `git worktree remove ${old}`) {
        await fs.rm(old, { recursive: true });
        throw new CommandError(
          "worktree metadata disappeared",
          options.label,
          command,
          options.cwd,
          128,
          "",
          `fatal: validation failed, cannot remove working tree: '${old}/.git' does not exist`,
        );
      }
      return result;
    };
    const marked: Array<{ id: number; note: string }> = [];

    const workspace = await prepareWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo, maxWorktrees: 1, cleanupBatchSize: 1 } }),
      run: row({ id: 100 }),
      completedRuns: [cleanupRow(1, old)],
      onWorktreeRemoved: async (id, note) => {
        marked.push({ id, note });
      },
      runner,
    });

    expect(workspace.cleanupNote).toContain("removed 1 old clean worktree");
    expect(marked).toEqual([
      { id: 1, note: "worktree disappeared during concurrent cleanup reconciliation" },
    ]);
    expect(runner.commands.map((item) => item.command.join(" "))).toContain("git fetch origin");
  });

  test("cleanup skips a broken candidate whose directory remains without Git metadata", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const root = path.join(repo, ".worktrees");
    const old = path.join(root, "old");
    await fs.mkdir(old, { recursive: true });
    const runner = recordingRunner();
    const runCommand = runner.run.bind(runner);
    runner.run = async (command, options) => {
      const result = await runCommand(command, options);
      if (command.join(" ") === `git worktree remove ${old}`) {
        throw new CommandError(
          "worktree metadata is missing",
          options.label,
          command,
          options.cwd,
          128,
          "",
          `fatal: validation failed, cannot remove working tree: '${old}/.git' does not exist`,
        );
      }
      return result;
    };

    const workspace = await prepareWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo, maxWorktrees: 1, cleanupBatchSize: 1 } }),
      run: row({ id: 100 }),
      completedRuns: [cleanupRow(1, old)],
      runner,
    });

    expect(workspace.cleanupNote).toContain("no clean completed worktrees");
    expect(workspace.cleanupNote).toContain("1 dirty skipped");
    expect(runner.commands.map((item) => item.command.join(" "))).toContain("git fetch origin");
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

  test("reuses a registered clean worktree and fast-forwards its upstream", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const worktree = path.join(repo, ".worktrees", "bot-testing");
    await fs.mkdir(worktree, { recursive: true });
    const runner = recordingRunner({
      worktreeList: [`worktree ${repo}`, "branch refs/heads/main", "", `worktree ${worktree}`, "branch refs/heads/agentrunner/test", ""].join("\n"),
      topLevel: worktree,
    });

    const workspace = await prepareReusedWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo } }),
      run: row({
        session_id: "session-1",
        reused_from_run_id: 17,
        repo_path: repo,
        worktree_path: worktree,
        branch_name: "agentrunner/test",
      }),
      runner,
    });

    expect(workspace.cwd).toBe(worktree);
    expect(runner.commands.map((item) => item.command.join(" "))).toEqual(
      expect.arrayContaining(["git fetch origin", "git merge --ff-only @{u}"]),
    );
  });

  test("reuses a dirty worktree without pulling into it", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const worktree = path.join(repo, ".worktrees", "bot-testing");
    await fs.mkdir(worktree, { recursive: true });
    const runner = recordingRunner({
      worktreeList: `worktree ${worktree}\nbranch refs/heads/agentrunner/test\n`,
      topLevel: worktree,
      dirtyStatus: " M src/file.ts\n",
    });

    const workspace = await prepareReusedWorkspace({
      config: serviceConfig({ cwd, git: { ...gitConfig(), repo } }),
      run: row({ session_id: "session-1", reused_from_run_id: 17, repo_path: repo, worktree_path: worktree }),
      runner,
    });

    expect(workspace.reuseLogs).toContain("Skipped fast-forward");
    expect(runner.commands.map((item) => item.command.join(" "))).not.toContain("git merge --ff-only @{u}");
  });

  test("rejects reuse when Git no longer registers the worktree", async () => {
    const cwd = await tempDir();
    const repo = path.join(cwd, "repo");
    const worktree = path.join(repo, ".worktrees", "bot-testing");
    await fs.mkdir(worktree, { recursive: true });

    await expect(
      prepareReusedWorkspace({
        config: serviceConfig({ cwd, git: { ...gitConfig(), repo } }),
        run: row({ session_id: "session-1", reused_from_run_id: 17, repo_path: repo, worktree_path: worktree }),
        runner: recordingRunner({ worktreeList: `worktree ${repo}\nbranch refs/heads/main\n` }),
      }),
    ).rejects.toThrow("no longer registered");
  });
});

function recordingRunner(
  options: {
    defaultStdout?: string;
    worktreeList?: string;
    transientFetchFailures?: number;
    topLevel?: string;
    dirtyStatus?: string;
  } = {},
): WorkspaceCommandRunner & {
  commands: Array<{ command: string[]; cwd: string; label: string }>;
} {
  const commands: Array<{ command: string[]; cwd: string; label: string }> = [];
  let transientFetchFailures = options.transientFetchFailures ?? 0;
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
      if (command.join(" ") === "git rev-parse --show-toplevel") {
        return { exitCode: 0, stdout: options.topLevel ? `${options.topLevel}\n` : "", stderr: "" };
      }
      if (command.join(" ") === "git status --porcelain") {
        return { exitCode: 0, stdout: options.dirtyStatus ?? "", stderr: "" };
      }
      if (command.join(" ") === "git fetch origin" && transientFetchFailures > 0) {
        transientFetchFailures--;
        throw Object.assign(new Error("connection reset while fetching"), { code: "ECONNRESET" });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function cleanupRow(id: number, worktreePath: string): CompletedRunForCleanup {
  return {
    id,
    worktree_path: worktreePath,
    branch_name: `agentrunner/run-${id}`,
    status: "succeeded",
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
    preflightRetries: 2,
    preflightRetryDelayMs: 0,
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
