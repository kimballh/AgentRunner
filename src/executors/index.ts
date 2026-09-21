import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { runCursor } from "./cursor.js";
import type { ExecutionInput, ExecutionResult } from "../types.js";

export async function runAgent(input: ExecutionInput): Promise<ExecutionResult> {
  if (input.resolved.provider === "codex") {
    return runCodex(input);
  }
  if (input.resolved.provider === "claude") {
    return runClaude(input);
  }
  return runCursor(input);
}
