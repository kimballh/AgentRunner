import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadDotenv, optionalEnv } from "./env.js";
import type { AgentMode, AgentProvider, AgentProviderMode, ServiceConfig, SetupMode, WorktreeMode } from "./types.js";

export interface ConfigOverrides {
  configPath?: string;
  databaseUrl?: string;
  databaseUrlEnvVar?: string;
  databaseSchema?: string;
  databaseTable?: string;
  agentProvider?: string;
  defaultAgentProvider?: string;
  agentMode?: string;
  numWorkers?: string | number;
  pollFrequencyMs?: string | number;
  staleAfterMs?: string | number;
  host?: string;
  port?: string | number;
  createWorktrees?: string;
  repo?: string;
  baseBranch?: string;
  worktreeDir?: string;
  maxWorktrees?: string | number;
  setupScript?: string;
  noSetup?: boolean;
}

type TomlConfig = Record<string, unknown>;

const DEFAULT_CONFIG_FILE = "agentrunner_config.toml";

export async function loadConfig(
  overrides: ConfigOverrides = {},
  cwd = process.cwd(),
  options: { requireDatabaseUrl?: boolean } = {},
): Promise<ServiceConfig> {
  loadDotenv(cwd);

  const configPath = path.resolve(
    cwd,
    stringFrom(overrides.configPath) ?? optionalEnv("AGENTRUNNER_CONFIG") ?? DEFAULT_CONFIG_FILE,
  );
  const toml = await readTomlConfig(configPath);
  const codexToml = section(toml.codex);
  const claudeToml = section(toml.claude);
  const gitToml = section(toml.git);

  const databaseUrlEnvVar =
    stringFrom(overrides.databaseUrlEnvVar) ??
    optionalEnv("AGENTRUNNER_DATABASE_URL_ENV_VAR") ??
    stringFrom(toml.database_url_env_var) ??
    "AGENTRUNNER_DATABASE_URL";
  const databaseUrl = stringFrom(overrides.databaseUrl) ?? optionalEnv(databaseUrlEnvVar);
  if (!databaseUrl && options.requireDatabaseUrl !== false) {
    throw new Error(`Database URL is required. Set --database-url or ${databaseUrlEnvVar}.`);
  }

  const config: ServiceConfig = {
    cwd,
    configPath,
    databaseUrl: databaseUrl ?? "",
    databaseUrlEnvVar,
    databaseSchema:
      stringFrom(overrides.databaseSchema) ??
      optionalEnv("AGENTRUNNER_DATABASE_SCHEMA") ??
      stringFrom(toml.database_schema) ??
      "public",
    databaseTable:
      stringFrom(overrides.databaseTable) ??
      optionalEnv("AGENTRUNNER_DATABASE_TABLE") ??
      stringFrom(toml.database_table) ??
      "agent_runs",
    agentProvider: parseAgentProviderMode(
      stringFrom(overrides.agentProvider) ??
        optionalEnv("AGENTRUNNER_AGENT_PROVIDER") ??
        stringFrom(toml.agent_provider) ??
        "both",
    ),
    defaultAgentProvider: parseAgentProvider(
      stringFrom(overrides.defaultAgentProvider) ??
        optionalEnv("AGENTRUNNER_DEFAULT_AGENT_PROVIDER") ??
        stringFrom(toml.default_agent_provider) ??
        "codex",
    ),
    agentMode: parseAgentMode(
      stringFrom(overrides.agentMode) ??
        optionalEnv("AGENTRUNNER_AGENT_MODE") ??
        stringFrom(toml.agent_mode) ??
        "exec",
    ),
    numWorkers: positiveInteger(
      numberFrom(overrides.numWorkers) ?? envNumber("AGENTRUNNER_NUM_WORKERS") ?? numberFrom(toml.num_workers) ?? 1,
      "num_workers",
    ),
    pollFrequencyMs: positiveInteger(
      numberFrom(overrides.pollFrequencyMs) ??
        envNumber("AGENTRUNNER_POLL_FREQUENCY_MS") ??
        envNumber("AGENTRUNNER_POLL_FREQUENCY") ??
        numberFrom(toml.poll_frequency_ms) ??
        60_000,
      "poll_frequency_ms",
    ),
    staleAfterMs: positiveInteger(
      numberFrom(overrides.staleAfterMs) ??
        envNumber("AGENTRUNNER_STALE_AFTER_MS") ??
        numberFrom(toml.stale_after_ms) ??
        15 * 60_000,
      "stale_after_ms",
    ),
    host: stringFrom(overrides.host) ?? optionalEnv("AGENTRUNNER_HOST") ?? stringFrom(toml.host) ?? "127.0.0.1",
    port: nonNegativeInteger(
      numberFrom(overrides.port) ?? envNumber("AGENTRUNNER_PORT") ?? numberFrom(toml.port) ?? 0,
      "port",
    ),
    git: {
      createWorktrees: parseWorktreeMode(
        stringFrom(overrides.createWorktrees) ??
          optionalEnv("AGENTRUNNER_CREATE_WORKTREES") ??
          stringFrom(gitToml.create_worktrees) ??
          "auto",
      ),
      repo: stringFrom(overrides.repo) ?? optionalEnv("AGENTRUNNER_REPO") ?? stringFrom(gitToml.repo),
      baseBranch:
        stringFrom(overrides.baseBranch) ?? optionalEnv("AGENTRUNNER_BASE_BRANCH") ?? stringFrom(gitToml.base_branch),
      remote: optionalEnv("AGENTRUNNER_REMOTE") ?? stringFrom(gitToml.remote) ?? "origin",
      branchPrefix: optionalEnv("AGENTRUNNER_BRANCH_PREFIX") ?? stringFrom(gitToml.branch_prefix) ?? "agentrunner",
      worktreeDir:
        stringFrom(overrides.worktreeDir) ??
        optionalEnv("AGENTRUNNER_WORKTREE_DIR") ??
        stringFrom(gitToml.worktree_dir) ??
        ".worktrees",
      maxWorktrees: nonNegativeInteger(
        numberFrom(overrides.maxWorktrees) ??
          envNumber("AGENTRUNNER_MAX_WORKTREES") ??
          numberFrom(gitToml.max_worktrees) ??
          25,
        "max_worktrees",
      ),
      cleanupBatchSize: positiveInteger(
        envNumber("AGENTRUNNER_CLEANUP_BATCH_SIZE") ?? numberFrom(gitToml.cleanup_batch_size) ?? 5,
        "cleanup_batch_size",
      ),
      cleanupDeleteBranches:
        envBoolean("AGENTRUNNER_CLEANUP_DELETE_BRANCHES") ?? booleanFrom(gitToml.cleanup_delete_branches) ?? false,
      setup: overrides.noSetup
        ? "never"
        : parseSetupMode(optionalEnv("AGENTRUNNER_SETUP") ?? stringFrom(gitToml.setup) ?? "auto"),
      setupScript:
        stringFrom(overrides.setupScript) ?? optionalEnv("AGENTRUNNER_SETUP_SCRIPT") ?? stringFrom(gitToml.setup_script),
      setupCommand: [...stringArray(gitToml.setup_command), ...envList("AGENTRUNNER_SETUP_COMMAND")],
    },
    codex: {
      bin: optionalEnv("AGENTRUNNER_CODEX_BIN") ?? stringFrom(codexToml.bin) ?? "codex",
      defaultModel: optionalEnv("AGENTRUNNER_CODEX_DEFAULT_MODEL") ?? stringFrom(codexToml.default_model),
      defaultReasoningEffort:
        optionalEnv("AGENTRUNNER_CODEX_DEFAULT_REASONING_EFFORT") ?? stringFrom(codexToml.default_reasoning_effort),
      sandbox: optionalEnv("AGENTRUNNER_CODEX_SANDBOX") ?? stringFrom(codexToml.sandbox),
      bypassApprovalsAndSandbox:
        envBoolean("AGENTRUNNER_CODEX_BYPASS_APPROVALS_AND_SANDBOX") ??
        booleanFrom(codexToml.bypass_approvals_and_sandbox) ??
        true,
      extraArgs: [...stringArray(codexToml.extra_args), ...envList("AGENTRUNNER_CODEX_EXTRA_ARGS")],
      appServerExtraArgs: [
        ...stringArray(codexToml.app_server_extra_args),
        ...envList("AGENTRUNNER_CODEX_APP_SERVER_EXTRA_ARGS"),
      ],
      config: [...stringArray(codexToml.config), ...envList("AGENTRUNNER_CODEX_CONFIG_OVERRIDES")],
    },
    claude: {
      bin: optionalEnv("AGENTRUNNER_CLAUDE_BIN") ?? stringFrom(claudeToml.bin) ?? "claude",
      defaultModel: optionalEnv("AGENTRUNNER_CLAUDE_DEFAULT_MODEL") ?? stringFrom(claudeToml.default_model),
      defaultReasoningEffort:
        optionalEnv("AGENTRUNNER_CLAUDE_DEFAULT_REASONING_EFFORT") ?? stringFrom(claudeToml.default_reasoning_effort),
      permissionMode: optionalEnv("AGENTRUNNER_CLAUDE_PERMISSION_MODE") ?? stringFrom(claudeToml.permission_mode),
      extraArgs: [...stringArray(claudeToml.extra_args), ...envList("AGENTRUNNER_CLAUDE_EXTRA_ARGS")],
    },
  };

  validateSqlIdentifier(config.databaseSchema, "database_schema");
  validateSqlIdentifier(config.databaseTable, "database_table");
  validateGitConfig(config);
  return config;
}

export function parseAgentProviderMode(value: string): AgentProviderMode {
  if (value === "codex" || value === "claude" || value === "both") {
    return value;
  }
  throw new Error(`Invalid agent_provider: ${value}`);
}

export function parseAgentProvider(value: string): AgentProvider {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(`Invalid default_agent_provider: ${value}`);
}

export function parseAgentMode(value: string): AgentMode {
  if (value === "exec" || value === "app-server") {
    return value;
  }
  throw new Error(`Invalid agent_mode: ${value}`);
}

export function parseWorktreeMode(value: string): WorktreeMode {
  if (value === "auto" || value === "always" || value === "never") {
    return value;
  }
  if (value === "true") {
    return "always";
  }
  if (value === "false") {
    return "never";
  }
  throw new Error(`Invalid git.create_worktrees: ${value}`);
}

export function parseSetupMode(value: string): SetupMode {
  if (value === "auto" || value === "always" || value === "never") {
    return value;
  }
  throw new Error(`Invalid git.setup: ${value}`);
}

export function validateSqlIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

async function readTomlConfig(configPath: string): Promise<TomlConfig> {
  try {
    const text = await fs.readFile(configPath, "utf8");
    return section(parseToml(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function section(value: unknown): TomlConfig {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TomlConfig) : {};
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanFrom(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function envNumber(name: string): number | undefined {
  return numberFrom(optionalEnv(name));
}

function envBoolean(name: string): boolean | undefined {
  const value = optionalEnv(name)?.toLowerCase();
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  return undefined;
}

function envList(name: string): string[] {
  const value = optionalEnv(name);
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function validateGitConfig(config: ServiceConfig): void {
  if (config.git.setupScript && config.git.setupCommand.length > 0) {
    throw new Error("git.setup_script and git.setup_command are mutually exclusive");
  }
  if (config.git.branchPrefix.includes("..") || config.git.branchPrefix.startsWith("/") || config.git.branchPrefix.endsWith("/")) {
    throw new Error(`Invalid git.branch_prefix: ${config.git.branchPrefix}`);
  }
}
