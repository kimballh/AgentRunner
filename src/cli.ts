#!/usr/bin/env node
import { Command } from "commander";
import { runChecks } from "./checks.js";
import { loadConfig, type ConfigOverrides } from "./config.js";
import { AgentRunnerService } from "./service.js";
import { migrationSql } from "./sql.js";
import { AgentRunStore } from "./store.js";

const program = new Command();

program
  .name("agentrunner")
  .description("Postgres-backed local agent job runner for Codex and Claude Code.")
  .version("0.1.0");

addConfigOptions(program.command("run").description("Start workers, poller, and dashboard."))
  .action(async (options) => {
    const config = await loadConfig(toOverrides(options), process.cwd());
    const service = new AgentRunnerService(config);
    await service.start();

    const shutdown = async (): Promise<void> => {
      await service.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

addConfigOptions(
  program
    .command("setup-db")
    .description("Create or migrate the configured Postgres schema/table.")
    .option("--force", "Drop and recreate the table if setup fails"),
)
  .action(async (options) => {
    const config = await loadConfig(toOverrides(options), process.cwd());
    const store = new AgentRunStore(config);
    try {
      try {
        await store.setup();
      } catch (error) {
        if (!options.force) {
          throw error;
        }
        console.warn(
          `Initial setup failed; dropping and recreating ${config.databaseSchema}.${config.databaseTable} because --force was set.`,
        );
        await store.dropTable();
        await store.setup();
      }
      console.log(`Database ready: ${config.databaseSchema}.${config.databaseTable}`);
    } finally {
      await store.close();
    }
  });

addConfigOptions(program.command("print-ddl").description("Print setup SQL without applying it."))
  .action(async (options) => {
    const config = await loadConfig(toOverrides(options), process.cwd(), { requireDatabaseUrl: false });
    console.log(migrationSql(config));
  });

addConfigOptions(program.command("check").description("Validate DB connectivity, table access, and agent binaries."))
  .action(async (options) => {
    const config = await loadConfig(toOverrides(options), process.cwd());
    const messages = await runChecks(config);
    for (const message of messages) {
      console.log(message);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function addConfigOptions(command: Command): Command {
  return command
    .option("--config <path>", "Path to agentrunner_config.toml")
    .option("--database-url <url>", "Postgres connection URL")
    .option("--database-url-env-var <name>", "Environment variable name containing the database URL")
    .option("--database-schema <name>", "Database schema name")
    .option("--database-table <name>", "Database table name")
    .option("--agent-provider <provider>", "codex, claude, or both")
    .option("--default-agent-provider <provider>", "codex or claude")
    .option("--agent-mode <mode>", "exec or app-server")
    .option("--num-workers <count>", "Number of concurrent workers")
    .option("--poll-frequency <ms>", "Poll frequency in milliseconds")
    .option("--poll-frequency-ms <ms>", "Poll frequency in milliseconds")
    .option("--stale-after-ms <ms>", "Running job stale heartbeat threshold")
    .option("--host <host>", "Dashboard host")
    .option("--port <port>", "Dashboard port")
    .option("--create-worktrees <mode>", "auto, always, never, true, or false")
    .option("--repo <path>", "Git repository root for worktree creation")
    .option("--base-branch <ref>", "Base branch/ref for worktree creation")
    .option("--worktree-dir <path>", "Directory for generated worktrees")
    .option("--max-worktrees <count>", "Maximum retained completed worktrees")
    .option("--setup-script <path>", "Setup script path to run in worktrees")
    .option("--no-setup", "Disable setup scripts");
}

function toOverrides(options: Record<string, unknown>): ConfigOverrides {
  return {
    configPath: stringOption(options.config),
    databaseUrl: stringOption(options.databaseUrl),
    databaseUrlEnvVar: stringOption(options.databaseUrlEnvVar),
    databaseSchema: stringOption(options.databaseSchema),
    databaseTable: stringOption(options.databaseTable),
    agentProvider: stringOption(options.agentProvider),
    defaultAgentProvider: stringOption(options.defaultAgentProvider),
    agentMode: stringOption(options.agentMode),
    numWorkers: stringOption(options.numWorkers),
    pollFrequencyMs: stringOption(options.pollFrequencyMs) ?? stringOption(options.pollFrequency),
    staleAfterMs: stringOption(options.staleAfterMs),
    host: stringOption(options.host),
    port: stringOption(options.port),
    createWorktrees: stringOption(options.createWorktrees),
    repo: stringOption(options.repo),
    baseBranch: stringOption(options.baseBranch),
    worktreeDir: stringOption(options.worktreeDir),
    maxWorktrees: stringOption(options.maxWorktrees),
    setupScript: stringOption(options.setupScript),
    noSetup: options.setup === false,
  };
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
