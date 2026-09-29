import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { redactSecrets } from "./redact.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
}

const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly label: string,
    readonly command: string[],
    readonly cwd: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export async function runProcess(
  command: string[],
  options: {
    cwd: string;
    stdin?: string;
    signal?: AbortSignal;
    terminationGraceMs?: number;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    maxCaptureBytes?: number;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return { stdout: "", stderr: "", exitCode: 1, aborted: true };
  }
  const subprocess = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const detachAbort = attachAbortSignal(subprocess, options.signal, options.terminationGraceMs);

  if (options.stdin !== undefined) {
    subprocess.stdin.write(options.stdin);
  }
  subprocess.stdin.end();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(subprocess.stdout, options.onStdoutLine, options.maxCaptureBytes),
      streamToString(subprocess.stderr, options.onStderrLine, options.maxCaptureBytes),
      once(subprocess, "close").then(([code]) => (typeof code === "number" ? code : 1)),
    ]);

    return {
      stdout: redactSecrets(stdout),
      stderr: redactSecrets(stderr),
      exitCode,
      aborted: Boolean(options.signal?.aborted),
    };
  } finally {
    detachAbort();
  }
}

export async function runCommandOrThrow(
  command: string[],
  options: {
    cwd: string;
    label: string;
    signal?: AbortSignal;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  },
): Promise<ProcessResult> {
  const result = await runProcess(command, options);
  if (result.exitCode !== 0) {
    throw new CommandError(
      `${options.label} failed with exit ${result.exitCode}: ${command.join(" ")}\n${result.stderr || result.stdout}`,
      options.label,
      command,
      options.cwd,
      result.exitCode,
      result.stdout,
      result.stderr,
    );
  }
  return result;
}

export function attachAbortSignal(
  subprocess: ChildProcess,
  signal?: AbortSignal,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): () => void {
  if (!signal) {
    return () => undefined;
  }

  let forceKillTimer: NodeJS.Timeout | undefined;
  let terminationStarted = false;
  const terminate = (): void => {
    if (terminationStarted) {
      return;
    }
    terminationStarted = true;
    signalSubprocess(subprocess, "SIGTERM");
    forceKillTimer = setTimeout(() => signalSubprocess(subprocess, "SIGKILL"), terminationGraceMs);
    forceKillTimer.unref();
  };
  const onClose = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };

  signal.addEventListener("abort", terminate, { once: true });
  subprocess.once("close", onClose);
  if (signal.aborted) {
    terminate();
  }

  return () => {
    signal.removeEventListener("abort", terminate);
    subprocess.removeListener("close", onClose);
    onClose();
  };
}

export function signalSubprocess(subprocess: ChildProcess, signal: NodeJS.Signals): void {
  if (!subprocess.pid || subprocess.exitCode !== null || subprocess.signalCode !== null) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-subprocess.pid, signal);
    } else {
      subprocess.kill(signal);
    }
  } catch (error) {
    if (process.platform !== "win32" && (error as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        subprocess.kill(signal);
      } catch {
        // The process may have exited between the state check and the signal.
      }
    }
  }
}

export async function streamToString(
  stream: Readable,
  onLine?: (line: string) => void,
  maxBytes = 32 * 1024 * 1024,
): Promise<string> {
  const chunks: Buffer[] = [];
  let captured = 0;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let skipped = false;
  const consume = (text: string): void => {
    if (!onLine) return;
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const ended = part.endsWith("\n");
      if (!skipped) pending += part;
      if (Buffer.byteLength(pending) > Math.max(65536, maxBytes)) {
        pending = "";
        skipped = true;
      }
      if (ended) {
        onLine(skipped ? "[oversized output line omitted]" : pending.replace(/\r?\n$/, ""));
        pending = "";
        skipped = false;
      }
    }
  };
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    consume(decoder.write(buffer));
    if (captured < maxBytes) {
      const kept = buffer.subarray(0, maxBytes - captured);
      chunks.push(kept);
      captured += kept.length;
    }
  }
  consume(decoder.end());
  if (onLine && (pending || skipped)) onLine(skipped ? "[oversized output line omitted]" : pending);
  return Buffer.concat(chunks).toString("utf8");
}

export function readLines(stream: Readable, onLine: (line: string) => void): Promise<void> {
  const lines = createInterface({ input: stream });
  lines.on("line", onLine);
  return once(lines, "close").then(() => undefined);
}
