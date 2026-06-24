export type AgentProvider = "codex" | "claude";
export type AgentProviderMode = AgentProvider | "both";
export type AgentMode = "exec" | "app-server";
export type RunStatus = "queued" | "retry" | "running" | "succeeded" | "failed";
export type WorktreeMode = "auto" | "always" | "never";
export type SetupMode = "auto" | "always" | "never";

export interface CodexConfig {
  bin: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  sandbox?: string;
  bypassApprovalsAndSandbox: boolean;
  extraArgs: string[];
  appServerExtraArgs: string[];
  config: string[];
}

export interface ClaudeConfig {
  bin: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  permissionMode?: string;
  extraArgs: string[];
}

export interface GitConfig {
  createWorktrees: WorktreeMode;
  repo?: string;
  baseBranch?: string;
  remote: string;
  branchPrefix: string;
  worktreeDir: string;
  maxWorktrees: number;
  cleanupBatchSize: number;
  cleanupDeleteBranches: boolean;
  setup: SetupMode;
  setupScript?: string;
  setupCommand: string[];
}

export interface ServiceConfig {
  cwd: string;
  configPath: string;
  databaseUrl: string;
  databaseUrlEnvVar: string;
  databaseSchema: string;
  databaseTable: string;
  agentProvider: AgentProviderMode;
  defaultAgentProvider: AgentProvider;
  agentMode: AgentMode;
  numWorkers: number;
  pollFrequencyMs: number;
  staleAfterMs: number;
  host: string;
  port: number;
  git: GitConfig;
  codex: CodexConfig;
  claude: ClaudeConfig;
}

export interface AgentRunRow {
  id: number;
  status: RunStatus | string;
  raw_webhook_data: unknown;
  prompt: string;
  uid: string;
  created_at: Date;
  finished_at: Date | null;
  link: string | null;
  last_message: string | null;
  conversation: unknown;
  attempts: number | null;
  logs: string | null;
  priority: number;
  error: unknown;
  model_name: string | null;
  reasoning_effort: string | null;
  agent_provider: string | null;
  agent_mode: string | null;
  num_retries: number | null;
  started_at?: Date | null;
  updated_at?: Date | null;
  locked_by?: string | null;
  locked_at?: Date | null;
  heartbeat_at?: Date | null;
  result?: unknown;
  exit_code?: number | null;
  repo_path?: string | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  base_branch?: string | null;
  setup_logs?: string | null;
  cleanup_note?: string | null;
}

export interface ResolvedRunConfig {
  provider: AgentProvider;
  mode: AgentMode;
  modelName?: string;
  reasoningEffort?: string;
}

export interface ClaimedRun {
  row: AgentRunRow;
  resolved: ResolvedRunConfig;
}

export interface ExecutionInput {
  prompt: string;
  cwd: string;
  resolved: ResolvedRunConfig;
  config: ServiceConfig;
}

export interface ExecutionResult {
  exitCode: number;
  link?: string;
  lastMessage?: string;
  conversation?: unknown;
  logs: string;
  result?: unknown;
  workspace?: WorkspaceResult;
}

export interface WorkspaceResult {
  cwd: string;
  repoPath?: string;
  worktreePath?: string;
  branchName?: string;
  baseBranch?: string;
  setupLogs?: string;
  cleanupNote?: string;
}

export interface WorkerStats {
  active: number;
  queued: number;
  maxWorkers: number;
  availableWorkers: number;
}
