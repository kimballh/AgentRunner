import { randomUUID } from "node:crypto";
import { startDashboard, type DashboardServer } from "./dashboard.js";
import { runAgent } from "./executors/index.js";
import { runPreflightPhase } from "./preflight.js";
import { AgentRunStore } from "./store.js";
import type { ExecutionResult, ServiceConfig, WorkerStats, WorkspaceResult } from "./types.js";
import { prepareWorkspace, runWorkspaceSetup, WorkspaceSetupError } from "./workspace.js";

export class AgentRunnerService {
  private readonly store: AgentRunStore;
  private readonly workerIdPrefix = `agentrunner-${process.pid}-${randomUUID().slice(0, 8)}`;
  private active = 0;
  private queued = 0;
  private stopping = false;
  private dashboard?: DashboardServer;
  private pollTimer?: NodeJS.Timeout;

  constructor(private readonly config: ServiceConfig) {
    this.store = new AgentRunStore(config);
  }

  async start(): Promise<void> {
    await this.store.recoverStaleRuns();
    this.dashboard = await startDashboard({
      config: this.config,
      store: this.store,
      stats: () => this.stats(),
    });
    console.log(`AgentRunner dashboard: ${this.dashboard.url}`);

    for (let index = 0; index < this.config.numWorkers; index++) {
      const workerId = `${this.workerIdPrefix}-${index + 1}`;
      void this.workerLoop(workerId).catch((error) => {
        if (!this.stopping) {
          console.error(`Worker ${workerId} stopped unexpectedly: ${errorMessage(error)}`);
        }
      });
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
    return {
      active: this.active,
      queued: this.queued,
      maxWorkers: this.config.numWorkers,
      availableWorkers: Math.max(0, this.config.numWorkers - this.active),
    };
  }

  private async refreshQueued(): Promise<void> {
    this.queued = await this.store.countQueued().catch(() => this.queued);
  }

  private async workerLoop(workerId: string): Promise<void> {
    while (!this.stopping) {
      let claimed;
      try {
        claimed = await this.store.claimNext(workerId);
      } catch (error) {
        this.logWorkerError(workerId, "claiming next run", error);
        await this.sleep(this.config.pollFrequencyMs);
        continue;
      }

      if (!claimed) {
        await this.sleep(this.config.pollFrequencyMs);
        continue;
      }

      this.active++;
      await this.refreshQueued();
      const heartbeat = setInterval(() => {
        void this.store
          .heartbeat(claimed.row.id, workerId)
          .catch((error) => this.logWorkerError(workerId, `heartbeating run ${claimed.row.id}`, error));
      }, Math.min(30_000, Math.max(5_000, Math.floor(this.config.staleAfterMs / 3))));

      let workspace: WorkspaceResult | undefined;
      try {
        const cleanupEnabled = this.config.git.maxWorktrees > 0;
        const completedRuns = cleanupEnabled
          ? await this.preflightPhase(workerId, claimed.row.id, "load cleanup candidates (database)", () =>
              this.store.completedRunsOldestFirst(),
            )
          : [];
        const recordedWorktreePaths = cleanupEnabled
          ? await this.preflightPhase(workerId, claimed.row.id, "load recorded worktree paths (database)", () =>
              this.store.recordedWorktreePaths(),
            )
          : [];
        workspace = await prepareWorkspace({
          config: this.config,
          run: claimed.row,
          completedRuns,
          recordedWorktreePaths,
          onWorktreeRemoved: (id, note) =>
            this.preflightPhase(workerId, claimed.row.id, "persist worktree cleanup (database)", () =>
              this.store.markWorktreeRemoved(id, note),
            ),
        });
        await this.preflightPhase(workerId, claimed.row.id, "persist workspace metadata (database)", () =>
          this.store.recordWorkspace(claimed.row.id, workerId, workspace!),
        );

        try {
          const setupLogs = await this.preflightPhase(workerId, claimed.row.id, "workspace setup", () =>
            runWorkspaceSetup(this.config, workspace!),
          );
          if (setupLogs) {
            workspace.setupLogs = setupLogs;
            await this.preflightPhase(workerId, claimed.row.id, "persist workspace setup logs (database)", () =>
              this.store.recordWorkspace(claimed.row.id, workerId, workspace!),
            );
          }
        } catch (error) {
          const setupError = findWorkspaceSetupError(error);
          if (setupError) {
            workspace.setupLogs = setupError.setupLogs;
            await this.preflightPhase(workerId, claimed.row.id, "persist failed workspace setup logs (database)", () =>
              this.store.recordWorkspace(claimed.row.id, workerId, workspace!),
            );
          }
          throw error;
        }

        const result = await runAgent({
          prompt: claimed.row.prompt,
          cwd: workspace.cwd,
          resolved: claimed.resolved,
          config: this.config,
        });
        result.workspace = workspace;
        if (workspace.setupLogs) {
          result.logs = `${workspace.setupLogs}\n${result.logs}`;
        }
        if (result.exitCode === 0) {
          await this.store.markSucceeded(claimed.row.id, workerId, result);
        } else {
          await this.store.markFailed(
            claimed.row.id,
            workerId,
            claimed.row,
            { message: `agent exited with code ${result.exitCode}` },
            result,
          );
        }
      } catch (error) {
        const result = workspace ? failureResultForWorkspace(workspace) : undefined;
        await this.preflightPhase(workerId, claimed.row.id, "persist run failure (database)", () =>
          this.store.markFailed(claimed.row.id, workerId, claimed.row, error, result),
        ).catch((markError) => {
          this.logWorkerError(workerId, `marking run ${claimed.row.id} failed`, markError);
        });
      } finally {
        clearInterval(heartbeat);
        this.active--;
        await this.refreshQueued();
      }
    }
  }

  private logWorkerError(workerId: string, action: string, error: unknown): void {
    console.warn(`Worker ${workerId} error while ${action}: ${errorMessage(error)}`);
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
