import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readLines, runProcess, streamToString } from "../process.js";
import { redactSecrets } from "../redact.js";
import type { ExecutionInput, ExecutionResult, ServiceConfig } from "../types.js";

export async function runCodex(input: ExecutionInput): Promise<ExecutionResult> {
  if (input.resolved.mode === "app-server") {
    return runCodexAppServer(input);
  }
  return runCodexExec(input);
}

export function parseExecThreadId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      const threadId = stringValue(event.thread_id) ?? stringValue(event.threadId);
      if ((type === "thread.started" || type === "thread_started") && threadId) {
        return threadId;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function threadUrl(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function codexConfigOverrides(input: ExecutionInput): string[] {
  const overrides = [...input.config.codex.config];
  if (input.resolved.reasoningEffort) {
    overrides.push(`model_reasoning_effort="${escapeConfigString(input.resolved.reasoningEffort)}"`);
  }
  return overrides;
}

async function runCodexExec(input: ExecutionInput): Promise<ExecutionResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentrunner-codex-"));
  const lastMessagePath = path.join(tempDir, "last-message.txt");
  try {
    const command = codexExecCommand(input, lastMessagePath);
    const result = await runProcess(command, { cwd: input.cwd, stdin: input.prompt });
    const threadId = parseExecThreadId(result.stdout);
    const lastMessage = await fs.readFile(lastMessagePath, "utf8").catch(() => "");
    const logs = combinedLogs(result.stdout, result.stderr);

    if (result.exitCode !== 0) {
      return {
        exitCode: result.exitCode,
        link: threadId ? threadUrl(threadId) : undefined,
        lastMessage,
        conversation: jsonLines(result.stdout),
        logs,
        result: { provider: "codex", mode: "exec", failed: true },
      };
    }

    return {
      exitCode: 0,
      link: threadId ? threadUrl(threadId) : undefined,
      lastMessage,
      conversation: jsonLines(result.stdout),
      logs,
      result: { provider: "codex", mode: "exec" },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runCodexAppServer(input: ExecutionInput): Promise<ExecutionResult> {
  const command = codexAppServerCommand(input);
  const subprocess = spawn(command[0]!, command.slice(1), {
    cwd: input.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closePromise = once(subprocess, "close").then(() => undefined);

  const stdoutLines: string[] = [];
  const conversation: unknown[] = [];
  let lastMessage = "";
  let threadId: string | undefined;
  let completed = false;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();

  const send = (message: Record<string, unknown>): void => {
    subprocess.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send({ id, method, params });
    return promise;
  };

  const completedPromise = new Promise<void>((resolve, reject) => {
    const failPending = (error: Error): void => {
      for (const item of pending.values()) {
        item.reject(error);
      }
      pending.clear();
    };

    void readLines(subprocess.stdout, (line) => {
      stdoutLines.push(line);
      const message = parseJsonObject(line);
      if (!message) {
        return;
      }
      conversation.push(message);

      const id = typeof message.id === "number" ? message.id : undefined;
      if (id !== undefined) {
        const waiter = pending.get(id);
        if (waiter) {
          pending.delete(id);
          if (isRecord(message.error)) {
            waiter.reject(new Error(stringValue(message.error.message) ?? "codex app-server request failed"));
          } else {
            waiter.resolve(isRecord(message.result) ? message.result : {});
          }
        }
        return;
      }

      const method = stringValue(message.method);
      const params = isRecord(message.params) ? message.params : {};
      if (method === "item/agentMessage/delta") {
        lastMessage += stringValue(params.delta) ?? "";
      } else if (method === "turn/completed") {
        completed = true;
        const turn = isRecord(params.turn) ? params.turn : {};
        const status = stringValue(turn.status);
        status === "failed" ? reject(new Error("codex app-server turn failed")) : resolve();
      } else if (method === "error") {
        reject(new Error(stringValue(params.message) ?? "codex app-server error"));
      }
    })
      .then(() => {
        if (!completed) {
          const error = new Error("codex app-server exited before turn completed");
          failPending(error);
          reject(error);
        }
      })
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        failPending(normalized);
        reject(normalized);
      });
  });

  const stderrPromise = streamToString(subprocess.stderr);
  try {
    await request("initialize", {
      clientInfo: { name: "agentrunner", title: "AgentRunner", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });

    const threadResult = await request("thread/start", {
      model: input.resolved.modelName ?? null,
      cwd: input.cwd,
      approvalPolicy: input.config.codex.bypassApprovalsAndSandbox ? "never" : null,
      sandbox: appServerSandbox(input.config),
      config: input.resolved.reasoningEffort ? { model_reasoning_effort: input.resolved.reasoningEffort } : null,
      serviceName: "agentrunner",
      ephemeral: false,
    });
    const thread = isRecord(threadResult.thread) ? threadResult.thread : {};
    threadId = stringValue(thread.id);
    if (!threadId) {
      throw new Error("codex app-server did not return a thread id");
    }

    await request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy: input.config.codex.bypassApprovalsAndSandbox ? "never" : null,
    });

    await completedPromise;
    const stderr = redactSecrets(await stopAppServer(subprocess, closePromise, stderrPromise));
    return {
      exitCode: 0,
      link: threadUrl(threadId),
      lastMessage,
      conversation,
      logs: combinedLogs(redactSecrets(stdoutLines.join("\n")), stderr),
      result: { provider: "codex", mode: "app-server" },
    };
  } catch (error) {
    const stderr = redactSecrets(await stopAppServer(subprocess, closePromise, stderrPromise).catch(() => ""));
    return {
      exitCode: 1,
      link: threadId ? threadUrl(threadId) : undefined,
      lastMessage,
      conversation,
      logs: combinedLogs(redactSecrets(stdoutLines.join("\n")), stderr),
      result: {
        provider: "codex",
        mode: "app-server",
        failed: true,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function codexExecCommand(input: ExecutionInput, lastMessagePath: string): string[] {
  const command = [input.config.codex.bin, "exec", "--cd", input.cwd, "--output-last-message", lastMessagePath];
  if (input.config.codex.bypassApprovalsAndSandbox) {
    command.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (input.config.codex.sandbox) {
    command.push("--sandbox", input.config.codex.sandbox);
  }
  if (input.resolved.modelName) {
    command.push("--model", input.resolved.modelName);
  }
  command.push("--json");
  for (const override of codexConfigOverrides(input)) {
    command.push("-c", override);
  }
  command.push(...input.config.codex.extraArgs, "-");
  return command;
}

function codexAppServerCommand(input: ExecutionInput): string[] {
  const command = [input.config.codex.bin, "app-server", "--stdio"];
  for (const override of codexConfigOverrides(input)) {
    command.push("-c", override);
  }
  command.push(...input.config.codex.appServerExtraArgs);
  return command;
}

async function stopAppServer(
  subprocess: ChildProcessWithoutNullStreams,
  closePromise: Promise<void>,
  stderrPromise: Promise<string>,
): Promise<string> {
  subprocess.kill();
  await closePromise.catch(() => undefined);
  return stderrPromise.catch(() => "");
}

function appServerSandbox(config: ServiceConfig): string | null {
  if (config.codex.bypassApprovalsAndSandbox) {
    return "danger-full-access";
  }
  return config.codex.sandbox ?? null;
}

function combinedLogs(stdout: string, stderr: string): string {
  return [`--- stdout ---\n${stdout}`, `--- stderr ---\n${stderr}`].join("\n");
}

function jsonLines(stdout: string): unknown[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => parseJsonObject(line))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeConfigString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
