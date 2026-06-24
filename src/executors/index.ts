import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import type { ExecutionInput, ExecutionResult } from "../types.js";

export async function runAgent(input: ExecutionInput): Promise<ExecutionResult> {
  return input.resolved.provider === "codex" ? runCodex(input) : runClaude(input);
}
