import { runProcess } from "../process.js";
import type { ExecutionInput, ExecutionResult } from "../types.js";

export async function runClaude(input: ExecutionInput): Promise<ExecutionResult> {
  const command = claudeCommand(input);
  const result = await runProcess(command, { cwd: input.cwd, stdin: input.prompt, signal: input.signal });
  const parsed = parseClaudeOutput(result.stdout);
  const sessionId = sessionIdFrom(parsed) ?? input.sessionId;
  const logs = [`--- stdout ---\n${result.stdout}`, `--- stderr ---\n${result.stderr}`].join("\n");

  return {
    exitCode: result.exitCode,
    lastMessage: lastMessageFrom(parsed) ?? result.stdout.trim(),
    conversation: parsed ?? result.stdout,
    logs,
    result: {
      provider: "claude",
      mode: "cli",
      parsed,
      failed: result.exitCode !== 0,
    },
    sessionId,
    resumeUnavailable:
      Boolean(input.sessionId) &&
      result.exitCode !== 0 &&
      /(?:session|conversation).*(?:not found|does not exist|unknown|failed to (?:load|resume))|no (?:session|conversation)/i.test(
        `${result.stderr}\n${result.stdout}`,
      ),
  };
}

function claudeCommand(input: ExecutionInput): string[] {
  const command = [input.config.claude.bin, "-p", "--output-format", "json"];
  if (input.sessionId) {
    command.push("--resume", input.sessionId);
  }
  if (input.resolved.modelName) {
    command.push("--model", input.resolved.modelName);
  }
  if (input.resolved.reasoningEffort) {
    command.push("--effort", input.resolved.reasoningEffort);
  }
  if (input.config.claude.permissionMode) {
    command.push("--permission-mode", input.config.claude.permissionMode);
  }
  command.push(...input.config.claude.extraArgs);
  return command;
}

export function sessionIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sessionId = record.session_id ?? record.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
}

function parseClaudeOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function lastMessageFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["result", "message", "text", "content"]) {
    const item = record[key];
    if (typeof item === "string" && item.length > 0) {
      return item;
    }
  }
  return undefined;
}
