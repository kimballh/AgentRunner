import { runProcess } from "../process.js";
import type { ExecutionInput, ExecutionResult } from "../types.js";

export async function runClaude(input: ExecutionInput): Promise<ExecutionResult> {
  const command = claudeCommand(input);
  let finalEvent: unknown;
  let streamedSession: string | undefined;
  const result = await runProcess(command, {
    cwd: input.cwd,
    stdin: input.prompt,
    signal: input.signal,
    maxCaptureBytes: input.config.outputMaxBytes,
    onStdoutLine: (line) => {
      input.observe?.({ source: "logs", kind: "stdout", text: line });
      const event = parseClaudeOutput(line);
      if (event) {
        input.observe?.({
          source: "conversation",
          kind: "provider",
          data: event,
        });
        const session = sessionIdFrom(event);
        if (session && session !== streamedSession)
          input.observe?.({
            source: "lifecycle",
            kind: "session",
            text: session,
          });
        streamedSession = session ?? streamedSession;
        if ((event as Record<string, unknown>).type === "result") finalEvent = event;
      }
    },
    onStderrLine: (line) => input.observe?.({ source: "logs", kind: "stderr", text: line }),
  });
  const parsed = finalEvent ?? parseClaudeOutput(result.stdout);
  const sessionId = sessionIdFrom(parsed) ?? streamedSession ?? input.sessionId;
  const logs = [`--- stdout ---\n${result.stdout}`, `--- stderr ---\n${result.stderr}`].join("\n");

  return {
    exitCode:
      parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).is_error ? 1 : result.exitCode,
    lastMessage: lastMessageFrom(parsed) ?? result.stdout.trim(),
    conversation: result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => parseClaudeOutput(line) ?? line),
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
  const command = [
    input.config.claude.bin,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
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
