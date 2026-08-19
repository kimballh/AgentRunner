import { randomUUID } from "node:crypto";
import { startDashboard, type DashboardServer } from "./dashboard.js";
import { runAgent } from "./executors/index.js";
import { runPreflightPhase } from "./preflight.js";
import { AgentRunStore, type CancellationRequestResult } from "./store.js";
import type {
  AgentProvider,
  ClaimedRun,
  ExecutionResult,
  ServiceConfig,
  WorkerStats,
  WorkspaceResult,
} from "./types.js";
import { prepareReusedWorkspace, prepareWorkspace, runWorkspaceSetup, WorkspaceSetupError } from "./workspace.js";

export class AgentRunnerService {
  private readonly store: AgentRunStore;
  private readonly workerIdPrefix = `agentrunner-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly providerActive: Record<AgentProvider, number> = { codex: 0, claude: 0 };
  private readonly providerWaiters: Record<AgentProvider, Array<() => void>> = { codex: [], claude: [] };
  private active = 0;
  private queued = 0;
  private stopping = false;
  private dashboard?: DashboardServer;
  private pollTimer?: NodeJS.Timeout;
  private readonly activeRuns = new Map<number, { workerId: string; controller: AbortController }>();

  constructor(private readonly config: ServiceConfig) {
    this.store = new AgentRunStore(config);
  }

  async start(): Promise<void> {
    await this.store.recoverStaleRuns();
    this.dashboard = await startDashboard({
      config: this.config,
      store: this.store,
      stats: () => this.stats(),
      cancelRun: (id) => this.cancelRun(id),
    });
    console.log(`AgentRunner dashboard: ${this.dashboard.url}`);

    for (const provider of this.enabledProviders()) {
      for (let index = 0; index < this.config.numWorkers; index++) {
        const workerId = `${this.workerIdPrefix}-${provider}-${index + 1}`;
        void this.workerLoop(workerId, provider).catch((error) => {
          if (!this.stopping) {
            console.error(`Worker ${workerId} stopped unexpectedly: ${errorMessage(error)}`);
          }
        });
      }
    }
    this.pollTimer = setInterval(() => {
      void this.refreshQueued();
    }, Math.min(this.config.pollFrequencyMs, 10_000));
    await this.refreshQueued();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    await this.dashboard?.close();
    await this.store.close();
  }

  stats(): WorkerStats {
    const maxWorkers = this.config.numWorkers * this.enabledProviders().length;
    return {
      active: this.active,
      queued: this.queued,
      maxWorkers,
      availableWorkers: Math.max(0, maxWorkers - this.active),
    };
  }

  private enabledProviders(): AgentProvider[] {
    return this.config.agentProvider === "both" ? ["codex", "claude"] : [this.config.agentProvider];
  }

  private async refreshQueued(): Promise<void> {
    this.queued = await this.store.countQueued().catch(() => this.queued);
  }

  private async workerLoop(workerId: string, provider: AgentProvider): Promise<void> {
    while (!this.stopping) {
      let claimed;
      try {
        claimed = await this.store.claimNext(workerId, this.config.agentProvider === "both" ? provider : undefined);
      } catch (error) {
        this.logWorkerError(workerId, "claiming next run", error);
        await this.sleep(this.config.pollFrequencyMs);
        continue;
      }

      if (!claimed) {
        await this.sleep(this.config.pollFrequencyMs);
        continue;
      }

      const controller = new AbortController();
      this.activeRuns.set(claimed.row.id, { workerId, controller });
      void this.store
        .isCancellationRequested(claimed.row.id, workerId)
        .then((cancelRequested) => {
          if (cancelRequested) {
            controller.abort();
          }
        })
        .catch((error) => this.logWorkerError(workerId, `checking cancellation for run ${claimed.row.id}`, error));
      this.active++;
      await this.refreshQueued();
      const heartbeat = setInterval(() => {
        void this.store
          .heartbeat(claimed.row.id, workerId)
          .then((cancelRequested) => {
            if (cancelRequested) {
              controller.abort();
            }
          })
          .catch((error) => this.logWorkerError(workerId, `heartbeating run ${claimed.row.id}`, error));
      }, Math.min(30_000, Math.max(5_000, Math.floor(this.config.staleAfterMs / 3))));

      let workspace: WorkspaceResult | undefined;
      try {
        const reuseRequested = Boolean(
          claimed.row.session_id && claimed.row.reused_from_run_id && claimed.row.worktree_path,
        );
        if (reuseRequested) {
          try {
            workspace = await prepareReusedWorkspace({
              config: this.config,
              run: claimed.row,
              signal: controller.signal,
            });
            await this.preflightPhase(workerId, claimed.row.id, "persist reused workspace metadata (database)", () =>
              this.store.recordWorkspace(claimed.row.id, workerId, workspace!),
            );
          } catch (error) {
            if (controller.signal.aborted) {
              throw error;
            }
            claimed.row = await this.preflightPhase(
              workerId,
              claimed.row.id,
              "record session reuse fallback (database)",
              () =>
                this.store.abandonSessionReuse(
                  claimed.row.id,
                  workerId,
                  claimed.requested,
                  claimed.requestedBaseBranch,
                  `reusable workspace unavailable: ${errorMessage(error)}`,
                ),
            );
            claimed.resolved = claimed.requested;
          }
        }

        workspace ??= await this.prepareFreshWorkspace(claimed, workerId, controller.signal);
        const initialCwd = workspace.cwd;

        let result = await this.withProviderSlot(claimed.resolved.provider, () =>
          runAgent({
            prompt: claimed.row.prompt,
            cwd: initialCwd,
            resolved: claimed.resolved,
            config: this.config,
            sessionId: claimed.row.reused_from_run_id ? claimed.row.session_id ?? undefined : undefined,
            signal: controller.signal,
          }),
        );
        if (!controller.signal.aborted && result.resumeUnavailable && claimed.row.reused_from_run_id) {
          claimed.row = await this.preflightPhase(
            workerId,
            claimed.row.id,
            "record missing session fallback (database)",
            () =>
              this.store.abandonSessionReuse(
                claimed.row.id,
                workerId,
                claimed.requested,
                claimed.requestedBaseBranch,
                "provider could not resume the retained session",
              ),
          );
          claimed.resolved = claimed.requested;
          workspace = await this.prepareFreshWorkspace(claimed, workerId, controller.signal);
          const fallbackCwd = workspace.cwd;
          result = await this.withProviderSlot(claimed.resolved.provider, () =>
            runAgent({
              prompt: claimed.row.prompt,
              cwd: fallbackCwd,
              resolved: claimed.resolved,
              config: this.config,
              signal: controller.signal,
            }),
          );
        }
        result.workspace = workspace;
        if (workspace.setupLogs) {
          result.logs = `${workspace.setupLogs}\n${result.logs}`;
        }
        if (workspace.reuseLogs) {
          result.logs = `--- session reuse workspace refresh ---\n${workspace.reuseLogs}\n${result.logs}`;
        }
        await this.finalizeResult(claimed, workerId, result, controller.signal);
      } catch (error) {
        const result = workspace ? failureResultForWorkspace(workspace) : undefined;
        await this.preflightPhase(workerId, claimed.row.id, "persist run failure (database)", () =>
          this.finalizeError(claimed, workerId, error, result, controller.signal),
        ).catch((markError) => {
          this.logWorkerError(workerId, `marking run ${claimed.row.id} failed`, markError);
        });
      } finally {
        clearInterval(heartbeat);
        if (this.activeRuns.get(claimed.row.id)?.controller === controller) {
          this.activeRuns.delete(claimed.row.id);
        }
        this.active--;
        await this.refreshQueued();
      }
    }
  }

  private async prepareFreshWorkspace(
    claimed: ClaimedRun,
    workerId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceResult> {
    const cleanupEnabled = this.config.git.maxWorktrees > 0;
    const workspace = await prepareWorkspace({
      config: this.config,
      run: claimed.row,
      completedRuns: [],
      loadCleanupState: cleanupEnabled
        ? async () => {
            const completedRuns = await this.preflightPhase(
              workerId,
              claimed.row.id,
              "load cleanup candidates (database)",
              () => this.store.completedRunsOldestFirst(),
            );
            const recordedWorktreePaths = await this.preflightPhase(
              workerId,
              claimed.row.id,
              "load recorded worktree paths (database)",
              () => this.store.recordedWorktreePaths(),
            );
            return { completedRuns, recordedWorktreePaths };
          }
        : undefined,
      withCleanupLock: cleanupEnabled
        ? (repoRoot, operation) =>
            this.preflightPhase(workerId, claimed.row.id, "acquire worktree cleanup lock (database)", () =>
              this.store.withWorktreeCleanupLock(repoRoot, operation),
            )
        : undefined,
      onWorktreeRemoved: (id, note) =>
        this.preflightPhase(workerId, claimed.row.id, "persist worktree cleanup (database)", () =>
          this.store.markWorktreeRemoved(id, note),
        ),
      signal,
    });
    await this.preflightPhase(workerId, claimed.row.id, "persist workspace metadata (database)", () =>
      this.store.recordWorkspace(claimed.row.id, workerId, workspace),
    );

    try {
      const setupLogs = await this.preflightPhase(workerId, claimed.row.id, "workspace setup", () =>
        runWorkspaceSetup(this.config, workspace, signal),
      );
      if (setupLogs) {
        workspace.setupLogs = setupLogs;
        await this.preflightPhase(workerId, claimed.row.id, "persist workspace setup logs (database)", () =>
          this.store.recordWorkspace(claimed.row.id, workerId, workspace),
        );
      }
    } catch (error) {
      const setupError = findWorkspaceSetupError(error);
      if (setupError) {
        workspace.setupLogs = setupError.setupLogs;
        await this.preflightPhase(workerId, claimed.row.id, "persist failed workspace setup logs (database)", () =>
          this.store.recordWorkspace(claimed.row.id, workerId, workspace),
        );
      }
      throw error;
    }
    return workspace;
  }

  private async cancelRun(id: number): Promise<CancellationRequestResult["outcome"]> {
    const result = await this.store.requestCancellation(id);
    if (result.outcome === "requested") {
      const active = this.activeRuns.get(id);
      if (active && active.workerId === result.lockedBy) {
        active.controller.abort();
      }
    }
    return result.outcome;
  }

  private async finalizeResult(
    claimed: ClaimedRun,
    workerId: string,
    result: ExecutionResult,
    signal: AbortSignal,
  ): Promise<void> {
    if (await this.cancellationRequested(claimed.row.id, workerId, signal)) {
      await this.store.markCancelled(claimed.row.id, workerId, result);
      return;
    }

    const finalized =
      result.exitCode === 0
        ? await this.store.markSucceeded(claimed.row.id, workerId, result)
        : await this.store.markFailed(
            claimed.row.id,
            workerId,
            claimed.row,
            { message: `agent exited with code ${result.exitCode}` },
            result,
          );
    if (!finalized && (await this.store.isCancellationRequested(claimed.row.id, workerId))) {
      await this.store.markCancelled(claimed.row.id, workerId, result);
    }
  }

  private async finalizeError(
    claimed: ClaimedRun,
    workerId: string,
    error: unknown,
    result: ExecutionResult | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (await this.cancellationRequested(claimed.row.id, workerId, signal)) {
      await this.store.markCancelled(claimed.row.id, workerId, result);
      return;
    }

    const finalized = await this.store.markFailed(claimed.row.id, workerId, claimed.row, error, result);
    if (!finalized && (await this.store.isCancellationRequested(claimed.row.id, workerId))) {
      await this.store.markCancelled(claimed.row.id, workerId, result);
    }
  }

  private async cancellationRequested(id: number, workerId: string, signal: AbortSignal): Promise<boolean> {
    return signal.aborted || this.store.isCancellationRequested(id, workerId);
  }

  private logWorkerError(workerId: string, action: string, error: unknown): void {
    console.warn(`Worker ${workerId} error while ${action}: ${errorMessage(error)}`);
  }

  private async withProviderSlot<T>(provider: AgentProvider, operation: () => Promise<T>): Promise<T> {
    await this.acquireProviderSlot(provider);
    try {
      return await operation();
    } finally {
      this.releaseProviderSlot(provider);
    }
  }

  private async acquireProviderSlot(provider: AgentProvider): Promise<void> {
    if (this.providerActive[provider] < this.config.numWorkers) {
      this.providerActive[provider]++;
      return;
    }
    await new Promise<void>((resolve) => this.providerWaiters[provider].push(resolve));
  }

  private releaseProviderSlot(provider: AgentProvider): void {
    const next = this.providerWaiters[provider].shift();
    if (next) {
      next();
      return;
    }
    this.providerActive[provider]--;
  }

  private preflightPhase<T>(workerId: string, runId: number, phase: string, operation: () => Promise<T>): Promise<T> {
    return runPreflightPhase(phase, operation, {
      retries: this.config.preflightRetries,
      delayMs: this.config.preflightRetryDelayMs,
      onRetry: (error, attempt, maxAttempts) => {
        this.logWorkerError(
          workerId,
          `running preflight phase "${phase}" for run ${runId}; retrying after attempt ${attempt}/${maxAttempts}`,
          error,
        );
      },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function failureResultForWorkspace(workspace: WorkspaceResult): ExecutionResult {
  return {
    exitCode: 1,
    logs: workspace.setupLogs ?? "",
    workspace,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findWorkspaceSetupError(error: unknown): WorkspaceSetupError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    if (current instanceof WorkspaceSetupError) {
      return current;
    }
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
