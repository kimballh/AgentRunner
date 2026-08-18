import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { runPreflightPhase } from "./preflight.js";
import { runCommandOrThrow, runProcess, type ProcessResult } from "./process.js";
import type { AgentRunRow, CompletedRunForCleanup, ServiceConfig, WorkspaceResult } from "./types.js";

export interface WorkspaceCommandRunner {
  run(command: string[], options: { cwd: string; label: string }): Promise<ProcessResult>;
}

export const defaultWorkspaceRunner: WorkspaceCommandRunner = {
  run: (command, options) => runCommandOrThrow(command, options),
};

export interface WorkspacePreparationInput {
  config: ServiceConfig;
  run: AgentRunRow;
  completedRuns: Iterable<CompletedRunForCleanup> | AsyncIterable<CompletedRunForCleanup>;
  recordedWorktreePaths?: Iterable<string>;
  loadCleanupState?: () => Promise<{
    completedRuns: Iterable<CompletedRunForCleanup> | AsyncIterable<CompletedRunForCleanup>;
    recordedWorktreePaths: Iterable<string>;
  }>;
  withCleanupLock?: <T>(repoRoot: string, operation: () => Promise<T>) => Promise<T>;
  onWorktreeRemoved?: (id: number, note: string) => Promise<void>;
  runner?: WorkspaceCommandRunner;
}

export async function prepareWorkspace(input: WorkspacePreparationInput): Promise<WorkspaceResult> {
  const runner = input.runner ?? defaultWorkspaceRunner;
  const repo = await workspacePhase(input.config, "resolve Git repository", () => resolveRepo(input.config, runner));
  if (!repo.enabled) {
    return { cwd: input.config.cwd };
  }

  const requestedBaseBranch = input.run.base_branch?.trim() || input.config.git.baseBranch;
  const worktreeRoot = resolveConfiguredPath(input.config.git.worktreeDir, repo.root);
  const suffix = shortId();
  const runName = `${slugify(input.run.uid)}-${input.run.id}-${suffix}`;
  const branchName = `${input.config.git.branchPrefix}/${runName}`;
  const worktreePath = path.join(worktreeRoot, runName);

  const cleanUp = async (): Promise<string | undefined> => {
    const cleanupState = input.loadCleanupState
      ? await input.loadCleanupState()
      : {
          completedRuns: input.completedRuns,
          recordedWorktreePaths: input.recordedWorktreePaths ?? [],
        };
    return workspacePhase(
      input.config,
      "clean up old worktrees",
      () =>
        cleanupOldWorktrees({
          config: input.config,
          repoRoot: repo.root,
          worktreeRoot,
          completedRuns: cleanupState.completedRuns,
          recordedWorktreePaths: cleanupState.recordedWorktreePaths,
          onWorktreeRemoved: input.onWorktreeRemoved,
          runner,
        }),
      0,
    );
  };
  const cleanupNote = input.withCleanupLock
    ? await input.withCleanupLock(repo.root, cleanUp)
    : await cleanUp();

  await workspacePhase(input.config, "create worktree directory", () => fs.mkdir(worktreeRoot, { recursive: true }));
  await workspacePhase(input.config, "fetch Git base branch", () =>
    runner.run(["git", "fetch", input.config.git.remote], {
      cwd: repo.root,
      label: "fetch base branch",
    }),
  );
  const baseBranch =
    requestedBaseBranch ??
    (await workspacePhase(input.config, "resolve Git base branch", () => resolveUpstreamBranch(repo.root, runner)));
  await workspacePhase(input.config, "create Git worktree", () =>
    runner.run(["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch], {
      cwd: repo.root,
      label: "create worktree",
    }),
  );

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
  } catch (error) {
    throw new Error("No upstream branch found; set [git].base_branch in agentrunner_config.toml", { cause: error });
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
  completedRuns: Iterable<CompletedRunForCleanup> | AsyncIterable<CompletedRunForCleanup>;
  recordedWorktreePaths: Iterable<string>;
  onWorktreeRemoved?: (id: number, note: string) => Promise<void>;
  runner: WorkspaceCommandRunner;
}): Promise<string | undefined> {
  if (input.config.git.maxWorktrees <= 0) {
    return undefined;
  }

  const existing: CleanupCandidate[] = await orphanedRegisteredWorktrees(input);
  let cleanupRequired = existing.length >= input.config.git.maxWorktrees;
  let checked = 0;
  let removed = 0;
  let dirty = 0;
  for await (const run of input.completedRuns) {
    if (!run.worktree_path || !isPathInside(run.worktree_path, input.worktreeRoot)) {
      continue;
    }
    if (!(await pathExists(run.worktree_path))) {
      await input.onWorktreeRemoved?.(run.id, "worktree path was already absent during cleanup reconciliation");
      continue;
    }
    existing.push({ path: run.worktree_path, branchName: run.branch_name ?? undefined, runId: run.id });
    if (!cleanupRequired && existing.length >= input.config.git.maxWorktrees) {
      cleanupRequired = true;
    }
    if (!cleanupRequired) {
      continue;
    }

    ({ checked, removed, dirty } = await removeCleanCandidates(input, existing, checked, removed, dirty));
    if (removed >= input.config.git.cleanupBatchSize) {
      break;
    }
  }

  if (!cleanupRequired) {
    return undefined;
  }

  ({ checked, removed, dirty } = await removeCleanCandidates(input, existing, checked, removed, dirty));

  if (removed === 0) {
    return dirty > 0
      ? `max_worktrees reached; no clean completed worktrees were available to remove (${dirty} dirty skipped)`
      : "max_worktrees reached; no completed worktrees were available to remove";
  }
  return `max_worktrees reached; removed ${removed} old clean worktree${removed === 1 ? "" : "s"}`;
}

interface CleanupCandidate {
  path: string;
  branchName?: string;
  runId?: number;
}

async function removeCleanCandidates(
  input: {
    config: ServiceConfig;
    repoRoot: string;
    runner: WorkspaceCommandRunner;
    onWorktreeRemoved?: (id: number, note: string) => Promise<void>;
  },
  candidates: CleanupCandidate[],
  checked: number,
  removed: number,
  dirty: number,
): Promise<{ checked: number; removed: number; dirty: number }> {
  while (checked < candidates.length && removed < input.config.git.cleanupBatchSize) {
    const candidate = candidates[checked++];
    let status: ProcessResult;
    try {
      status = await input.runner.run(["git", "status", "--porcelain"], {
        cwd: candidate.path,
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
    try {
      await workspacePhase(input.config, "remove old Git worktree", () =>
        input.runner.run(["git", "worktree", "remove", candidate.path], {
          cwd: input.repoRoot,
          label: "remove old worktree",
        }),
      );
    } catch (error) {
      if (!(await pathExists(candidate.path))) {
        if (candidate.runId !== undefined) {
          await input.onWorktreeRemoved?.(
            candidate.runId,
            "worktree disappeared during concurrent cleanup reconciliation",
          );
        }
        removed++;
        continue;
      }
      if (isMissingWorktreeMetadataError(error) && !(await pathExists(path.join(candidate.path, ".git")))) {
        dirty++;
        continue;
      }
      throw error;
    }
    if (candidate.runId !== undefined) {
      await input.onWorktreeRemoved?.(candidate.runId, "worktree removed by cleanup");
    }
    if (input.config.git.cleanupDeleteBranches && candidate.branchName) {
      await workspacePhase(input.config, "delete old Git worktree branch", () =>
        input.runner.run(["git", "branch", "-D", candidate.branchName!], {
          cwd: input.repoRoot,
          label: "delete old worktree branch",
        }),
      );
    }
    removed++;
  }

  return { checked, removed, dirty };
}

async function orphanedRegisteredWorktrees(input: {
  config: ServiceConfig;
  repoRoot: string;
  worktreeRoot: string;
  recordedWorktreePaths: Iterable<string>;
  runner: WorkspaceCommandRunner;
}): Promise<CleanupCandidate[]> {
  const listed = await workspacePhase(input.config, "list registered Git worktrees", () =>
    input.runner.run(["git", "worktree", "list", "--porcelain"], {
      cwd: input.repoRoot,
      label: "list registered worktrees",
    }),
  );
  const recorded = new Set(Array.from(input.recordedWorktreePaths, (item) => path.resolve(item)));
  const branchPrefix = `refs/heads/${input.config.git.branchPrefix}/`;
  const graceCutoff = Date.now() - input.config.staleAfterMs;
  const candidates: Array<CleanupCandidate & { modifiedAt: number }> = [];

  for (const worktree of parseWorktreeList(listed.stdout)) {
    const resolvedPath = path.resolve(worktree.path);
    if (
      recorded.has(resolvedPath) ||
      !isPathInside(resolvedPath, input.worktreeRoot) ||
      !worktree.branch?.startsWith(branchPrefix)
    ) {
      continue;
    }
    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.mtimeMs > graceCutoff) {
        continue;
      }
      candidates.push({
        path: resolvedPath,
        branchName: worktree.branch.slice("refs/heads/".length),
        modifiedAt: stat.mtimeMs,
      });
    } catch {
      // Missing registered worktrees are left for Git's own prune mechanism.
    }
  }

  return candidates.sort((left, right) => left.modifiedAt - right.modifiedAt);
}

function parseWorktreeList(output: string): Array<{ path: string; branch?: string }> {
  const worktrees: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current && line.length === 0) {
      worktrees.push(current);
      current = undefined;
    }
  }
  if (current) {
    worktrees.push(current);
  }
  return worktrees;
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function isMissingWorktreeMetadataError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current !== "object") {
      return /\.git.*does not exist|not a working tree/i.test(String(current));
    }
    const record = current as Record<string, unknown>;
    const diagnostics = [record.message, record.stderr].filter((value): value is string => typeof value === "string");
    if (diagnostics.some((value) => /\.git.*does not exist|not a working tree/i.test(value))) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

function section(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function workspacePhase<T>(
  config: ServiceConfig,
  phase: string,
  operation: () => Promise<T>,
  retries = config.preflightRetries,
): Promise<T> {
  return runPreflightPhase(phase, operation, {
    retries,
    delayMs: config.preflightRetryDelayMs,
    onRetry: (error, attempt, maxAttempts) => {
      console.warn(
        `Preflight phase "${phase}" failed on attempt ${attempt}/${maxAttempts}; retrying: ${errorMessage(error)}`,
      );
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
