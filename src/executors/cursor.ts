import { runProcess } from "../process.js";
import type { ExecutionInput, ExecutionResult } from "../types.js";

export async function runCursor(input: ExecutionInput): Promise<ExecutionResult> {
  const command = cursorCommand(input);
  const result = await runProcess(command, { cwd: input.cwd, signal: input.signal });
  const parsed = parseCursorOutput(result.stdout);
  const sessionId = cursorSessionId(parsed) ?? input.sessionId;
  const lastMessage = cursorLastMessage(parsed) ?? result.stdout.trim();
  const logs = [`--- stdout ---\n${result.stdout}`, `--- stderr ---\n${result.stderr}`].join("\n");

  return {
    exitCode: result.exitCode,
    lastMessage,
    conversation: parsed ?? result.stdout,
    logs,
    result: {
      provider: "cursor",
      mode: input.config.cursor.mode,
      parsed,
      failed: result.exitCode !== 0,
    },
    sessionId,
    resumeUnavailable:
      Boolean(input.sessionId) &&
      result.exitCode !== 0 &&
      /(?:chat|session|conversation).*(?:not found|does not exist|unknown|failed to (?:load|resume))|no (?:chat|session|conversation)/i.test(
        `${result.stderr}\n${result.stdout}`,
      ),
  };
}

function cursorCommand(input: ExecutionInput): string[] {
  const command = [
    input.config.cursor.bin,
    "--print",
    "--output-format",
    "json",
    "--mode",
    input.config.cursor.mode,
    "--sandbox",
    input.config.cursor.sandbox,
  ];
  if (input.sessionId) {
    command.push("--resume", input.sessionId);
  }
  if (input.resolved.modelName) {
    command.push("--model", input.resolved.modelName);
  }
  if (input.config.cursor.force) {
    command.push("--force");
  }
  command.push(...input.config.cursor.extraArgs, input.prompt);
  return command;
}

export function cursorSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["session_id", "sessionId", "chat_id", "chatId"]) {
    const item = record[key];
    if (typeof item === "string" && item.trim()) {
      return item;
    }
  }
  return undefined;
}

function parseCursorOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const objects = text
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((item) => item !== undefined);
    return objects.length > 0 ? objects : undefined;
  }
}

function cursorLastMessage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const message = cursorLastMessage(item);
      if (message) {
        return message;
      }
    }
    return undefined;
  }
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
