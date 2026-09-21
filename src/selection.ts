import { parseAgentMode, parseAgentProvider } from "./config.js";
import type { AgentRunRow, ResolvedRunConfig, ServiceConfig } from "./types.js";

export function resolveRunConfig(row: AgentRunRow, config: ServiceConfig): ResolvedRunConfig {
  const provider =
    config.agentProvider === "both" || config.agentProvider === "all"
      ? row.agent_provider
        ? parseAgentProvider(row.agent_provider)
        : config.defaultAgentProvider
      : config.agentProvider;

  const mode = provider === "codex" && row.agent_mode ? parseAgentMode(row.agent_mode) : config.agentMode;
  const providerDefaults =
    provider === "codex" ? config.codex : provider === "claude" ? config.claude : config.cursor;
  const defaultReasoningEffort =
    provider === "codex"
      ? config.codex.defaultReasoningEffort
      : provider === "claude"
        ? config.claude.defaultReasoningEffort
        : undefined;

  return {
    provider,
    mode,
    modelName: row.model_name ?? providerDefaults.defaultModel,
    reasoningEffort: row.reasoning_effort ?? defaultReasoningEffort,
  };
}
