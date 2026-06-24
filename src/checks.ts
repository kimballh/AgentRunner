import { spawnSync } from "node:child_process";
import { qualifiedTable } from "./sql.js";
import { AgentRunStore } from "./store.js";
import type { ServiceConfig } from "./types.js";

export async function runChecks(config: ServiceConfig): Promise<string[]> {
  const messages: string[] = [];
  const store = new AgentRunStore(config);
  try {
    await store.query("SELECT 1 AS ok");
    messages.push("database: ok");
    await store.query(`SELECT 1 FROM ${qualifiedTable(config)} LIMIT 1`);
    messages.push(`table ${config.databaseSchema}.${config.databaseTable}: ok`);
  } finally {
    await store.close();
  }

  if (config.agentProvider === "codex" || config.agentProvider === "both") {
    messages.push(commandExists(config.codex.bin) ? `codex binary: ${config.codex.bin}` : `codex binary missing: ${config.codex.bin}`);
  }
  if (config.agentProvider === "claude" || config.agentProvider === "both") {
    messages.push(
      commandExists(config.claude.bin) ? `claude binary: ${config.claude.bin}` : `claude binary missing: ${config.claude.bin}`,
    );
  }
  return messages;
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
