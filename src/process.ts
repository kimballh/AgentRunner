import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { redactSecrets } from "./redact.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

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

export async function runProcess(command: string[], options: { cwd: string; stdin?: string }): Promise<ProcessResult> {
  const subprocess = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (options.stdin !== undefined) {
    subprocess.stdin.write(options.stdin);
  }
  subprocess.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToString(subprocess.stdout),
    streamToString(subprocess.stderr),
    once(subprocess, "close").then(([code]) => (typeof code === "number" ? code : 1)),
  ]);

  return {
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
    exitCode,
  };
}

export async function runCommandOrThrow(command: string[], options: { cwd: string; label: string }): Promise<ProcessResult> {
  const result = await runProcess(command, { cwd: options.cwd });
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

export async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function readLines(stream: Readable, onLine: (line: string) => void): Promise<void> {
  const lines = createInterface({ input: stream });
  lines.on("line", onLine);
  return once(lines, "close").then(() => undefined);
}
