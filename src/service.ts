import { randomUUID } from "node:crypto";
import { startDashboard, type DashboardServer } from "./dashboard.js";
import { runAgent } from "./executors/index.js";
import { AgentRunStore, errorToJson } from "./store.js";
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
      void this.workerLoop(`${this.workerIdPrefix}-${index + 1}`);
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
      const claimed = await this.store.claimNext(workerId);
      if (!claimed) {
        await this.sleep(this.config.pollFrequencyMs);
        continue;
      }

      this.active++;
      await this.refreshQueued();
      const heartbeat = setInterval(() => {
        void this.store.heartbeat(claimed.row.id, workerId);
      }, Math.min(30_000, Math.max(5_000, Math.floor(this.config.staleAfterMs / 3))));

      let workspace: WorkspaceResult | undefined;
      try {
        const completedRuns = await this.store.completedRunsOldestFirst();
        workspace = await prepareWorkspace({
          config: this.config,
          run: claimed.row,
          completedRuns,
        });
        await this.store.recordWorkspace(claimed.row.id, workerId, workspace);

        try {
          const setupLogs = await runWorkspaceSetup(this.config, workspace);
          if (setupLogs) {
            workspace.setupLogs = setupLogs;
            await this.store.recordWorkspace(claimed.row.id, workerId, workspace);
          }
        } catch (error) {
          if (error instanceof WorkspaceSetupError) {
            workspace.setupLogs = error.setupLogs;
            await this.store.recordWorkspace(claimed.row.id, workerId, workspace);
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
        await this.store.markFailed(claimed.row.id, workerId, claimed.row, errorToJson(error), result);
      } finally {
        clearInterval(heartbeat);
        this.active--;
        await this.refreshQueued();
      }
    }
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
