export type AgentProvider = "codex" | "claude";
export type AgentProviderMode = AgentProvider | "both";
export type AgentMode = "exec" | "app-server";
export type RunStatus = "queued" | "retry" | "running" | "succeeded" | "failed" | "cancelled";
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
  preflightRetries: number;
  preflightRetryDelayMs: number;
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
  worktree_removed_at?: Date | null;
  reuse_session?: boolean;
  session_id?: string | null;
  reused_from_run_id?: number | null;
  reuse_fallback_reason?: string | null;
  requested_agent_provider?: string | null;
  requested_agent_mode?: string | null;
  requested_model_name?: string | null;
  requested_reasoning_effort?: string | null;
  requested_base_branch?: string | null;
  cancel_requested_at?: Date | null;
}

export interface RunListItem {
  id: number;
  status: RunStatus | string;
  uid: string;
  created_at: Date;
  created_at_cursor: string;
  finished_at: Date | null;
  link: string | null;
  last_message: string | null;
  attempts: number | null;
  priority: number;
  model_name: string | null;
  reasoning_effort: string | null;
  agent_provider: string | null;
  agent_mode: string | null;
  num_retries: number | null;
  started_at?: Date | null;
  updated_at?: Date | null;
  repo_path?: string | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  base_branch?: string | null;
  cleanup_note?: string | null;
  reuse_session?: boolean;
  session_id?: string | null;
  reused_from_run_id?: number | null;
  reuse_fallback_reason?: string | null;
  cancel_requested_at?: Date | null;
  has_error: boolean;
  has_logs: boolean;
  has_setup_logs: boolean;
  has_conversation: boolean;
}

export interface CompletedRunForCleanup {
  id: number;
  worktree_path: string | null;
  branch_name?: string | null;
  status: RunStatus | string;
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
  requested: ResolvedRunConfig;
  requestedBaseBranch?: string | null;
}

export interface ExecutionInput {
  prompt: string;
  cwd: string;
  resolved: ResolvedRunConfig;
  config: ServiceConfig;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ExecutionResult {
  exitCode: number;
  link?: string;
  lastMessage?: string;
  conversation?: unknown;
  logs: string;
  result?: unknown;
  workspace?: WorkspaceResult;
  sessionId?: string;
  resumeUnavailable?: boolean;
}

export interface WorkspaceResult {
  cwd: string;
  repoPath?: string;
  worktreePath?: string;
  branchName?: string;
  baseBranch?: string;
  setupLogs?: string;
  cleanupNote?: string;
  reuseLogs?: string;
}

export interface WorkerStats {
  active: number;
  queued: number;
  maxWorkers: number;
  availableWorkers: number;
}
