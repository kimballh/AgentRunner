import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { runCommandOrThrow, runProcess, type ProcessResult } from "./process.js";
import type { AgentRunRow, ServiceConfig, WorkspaceResult } from "./types.js";

export interface WorkspaceCommandRunner {
  run(command: string[], options: { cwd: string; label: string }): Promise<ProcessResult>;
}

export const defaultWorkspaceRunner: WorkspaceCommandRunner = {
  run: (command, options) => runCommandOrThrow(command, options),
};

export interface WorkspacePreparationInput {
  config: ServiceConfig;
  run: AgentRunRow;
  completedRuns: AgentRunRow[];
  runner?: WorkspaceCommandRunner;
}

export async function prepareWorkspace(input: WorkspacePreparationInput): Promise<WorkspaceResult> {
  const runner = input.runner ?? defaultWorkspaceRunner;
  const repo = await resolveRepo(input.config, runner);
  if (!repo.enabled) {
    return { cwd: input.config.cwd };
  }

  const baseBranch = input.config.git.baseBranch ?? (await resolveUpstreamBranch(repo.root, runner));
  const worktreeRoot = resolveConfiguredPath(input.config.git.worktreeDir, repo.root);
  const suffix = shortId();
  const runName = `${slugify(input.run.uid)}-${input.run.id}-${suffix}`;
  const branchName = `${input.config.git.branchPrefix}/${runName}`;
  const worktreePath = path.join(worktreeRoot, runName);

  const cleanupNote = await cleanupOldWorktrees({
    config: input.config,
    repoRoot: repo.root,
    worktreeRoot,
    completedRuns: input.completedRuns,
    runner,
  });

  await fs.mkdir(worktreeRoot, { recursive: true });
  await runner.run(["git", "fetch", input.config.git.remote], {
    cwd: repo.root,
    label: "fetch base branch",
  });
  await runner.run(["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch], {
    cwd: repo.root,
    label: "create worktree",
  });

  return {
    cwd: worktreePath,
    repoPath: repo.root,
    worktreePath,
    branchName,
    baseBranch,
    cleanupNote,
  };
}

export async function runWorkspaceSetup(config: ServiceConfig, workspace: WorkspaceResult): Promise<string | undefined> {
  if (!workspace.worktreePath || config.git.setup === "never") {
    return undefined;
  }

  if (config.git.setupCommand.length > 0) {
    const result = await runProcess(config.git.setupCommand, { cwd: workspace.worktreePath });
    const logs = logsFor(result);
    if (result.exitCode !== 0) {
      throw new WorkspaceSetupError(`setup command failed with exit ${result.exitCode}`, logs);
    }
    return logs;
  }

  const script = await resolveSetupScript(config, workspace);
  if (!script) {
    if (config.git.setup === "always") {
      throw new Error("git.setup is always but no setup script was found");
    }
    return undefined;
  }

  const result = await runProcess(["bash", script.path], {
    cwd: workspace.worktreePath,
    stdin: script.inlineScript,
  });
  const logs = logsFor(result);
  if (result.exitCode !== 0) {
    throw new WorkspaceSetupError(`setup failed with exit ${result.exitCode}`, logs);
  }
  return logs;
}

export class WorkspaceSetupError extends Error {
  constructor(message: string, readonly setupLogs: string) {
    super(message);
    this.name = "WorkspaceSetupError";
  }
}

async function resolveRepo(
  config: ServiceConfig,
  runner: WorkspaceCommandRunner,
): Promise<{ enabled: false } | { enabled: true; root: string }> {
  if (config.git.createWorktrees === "never") {
    return { enabled: false };
  }
  const configuredRepo = config.git.repo ? path.resolve(config.cwd, config.git.repo) : undefined;
  if (configuredRepo) {
    return { enabled: true, root: configuredRepo };
  }

  const result = await runProcess(["git", "rev-parse", "--show-toplevel"], { cwd: config.cwd });
  if (result.exitCode !== 0) {
    if (config.git.createWorktrees === "always") {
      throw new Error("git.create_worktrees is always but cwd is not inside a Git repository");
    }
    return { enabled: false };
  }

  const root = result.stdout.trim();
  if (!root) {
    if (config.git.createWorktrees === "always") {
      throw new Error("Unable to resolve Git repository root");
    }
    return { enabled: false };
  }

  await runner.run(["git", "rev-parse", "--git-dir"], { cwd: root, label: "verify git repository" });
  return { enabled: true, root };
}

async function resolveUpstreamBranch(repoRoot: string, runner: WorkspaceCommandRunner): Promise<string> {
  let result: ProcessResult;
  try {
    result = await runner.run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: repoRoot,
      label: "resolve upstream branch",
    });
  } catch {
    throw new Error("No upstream branch found; set [git].base_branch in agentrunner_config.toml");
  }
  const branch = result.stdout.trim();
  if (!branch) {
    throw new Error("No upstream branch found; set [git].base_branch in agentrunner_config.toml");
  }
  return branch;
}

async function cleanupOldWorktrees(input: {
  config: ServiceConfig;
  repoRoot: string;
  worktreeRoot: string;
  completedRuns: AgentRunRow[];
  runner: WorkspaceCommandRunner;
}): Promise<string | undefined> {
  if (input.config.git.maxWorktrees <= 0) {
    return undefined;
  }

  const existing = [];
  for (const run of input.completedRuns) {
    if (run.worktree_path && isPathInside(run.worktree_path, input.worktreeRoot) && (await pathExists(run.worktree_path))) {
      existing.push(run);
    }
  }
  if (existing.length < input.config.git.maxWorktrees) {
    return undefined;
  }

  let removed = 0;
  let dirty = 0;
  for (const run of existing) {
    if (removed >= input.config.git.cleanupBatchSize) {
      break;
    }
    if (!run.worktree_path || !isPathInside(run.worktree_path, input.worktreeRoot)) {
      continue;
    }
    let status: ProcessResult;
    try {
      status = await input.runner.run(["git", "status", "--porcelain"], {
        cwd: run.worktree_path,
        label: "check worktree cleanliness",
      });
    } catch {
      dirty++;
      continue;
    }
    if (status.stdout.trim().length > 0) {
      dirty++;
      continue;
    }
    await input.runner.run(["git", "worktree", "remove", run.worktree_path], {
      cwd: input.repoRoot,
      label: "remove old worktree",
    });
    if (input.config.git.cleanupDeleteBranches && run.branch_name) {
      await input.runner.run(["git", "branch", "-D", run.branch_name], {
        cwd: input.repoRoot,
        label: "delete old worktree branch",
      });
    }
    removed++;
  }

  if (removed === 0) {
    return dirty > 0
      ? `max_worktrees reached; no clean completed worktrees were available to remove (${dirty} dirty skipped)`
      : "max_worktrees reached; no completed worktrees were available to remove";
  }
  return `max_worktrees reached; removed ${removed} old clean worktree${removed === 1 ? "" : "s"}`;
}

async function resolveSetupScript(
  config: ServiceConfig,
  workspace: WorkspaceResult,
): Promise<{ path: string; inlineScript?: string } | undefined> {
  if (config.git.setupScript) {
    return { path: resolveConfiguredPath(config.git.setupScript, workspace.repoPath ?? workspace.worktreePath ?? config.cwd) };
  }

  const environmentPath = path.join(workspace.worktreePath ?? config.cwd, ".codex", "environments", "environment.toml");
  if (!(await pathExists(environmentPath))) {
    return undefined;
  }
  const parsed = parseToml(await fs.readFile(environmentPath, "utf8")) as Record<string, unknown>;
  const setup = section(parsed.setup);
  const script = typeof setup.script === "string" ? setup.script : "";
  if (!script) {
    return undefined;
  }
  return { path: "-", inlineScript: script };
}

function logsFor(result: ProcessResult): string {
  return [`--- setup stdout ---\n${result.stdout}`, `--- setup stderr ---\n${result.stderr}`].join("\n");
}

function resolveConfiguredPath(input: string, base: string): string {
  if (input.startsWith("~")) {
    return path.join(process.env.HOME ?? "", input.slice(1));
  }
  return path.isAbsolute(input) ? input : path.resolve(base, input);
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "run";
}

function shortId(): string {
  return crypto.randomUUID().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await fs.stat(input);
    return true;
  } catch {
    return false;
  }
}

function section(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
