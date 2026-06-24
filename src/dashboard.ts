import http from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRunStore } from "./store.js";
import type { AgentRunRow, ServiceConfig, WorkerStats } from "./types.js";

export interface DashboardServer {
  url: string;
  close: () => Promise<void>;
}

export async function startDashboard(input: {
  config: ServiceConfig;
  store: AgentRunStore;
  stats: () => WorkerStats;
}): Promise<DashboardServer> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, { ok: true, ...input.stats() });
      }
      if (request.method === "GET" && url.pathname === "/runs") {
        const runs = await input.store.listRuns();
        return html(response, renderRunsPage({ runs, stats: input.stats(), config: input.config }));
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        const runs = await input.store.listRuns();
        return json(response, { runs, stats: input.stats() });
      }

      const detailMatch = /^\/api\/runs\/(\d+)$/.exec(url.pathname);
      if (request.method === "GET" && detailMatch) {
        const run = await input.store.getRun(Number(detailMatch[1]));
        return run ? json(response, { run }) : json(response, { error: "run not found" }, 404);
      }

      const logsMatch = /^\/api\/runs\/(\d+)\/logs$/.exec(url.pathname);
      if (request.method === "GET" && logsMatch) {
        const run = await input.store.getRun(Number(logsMatch[1]));
        return run ? text(response, run.logs ?? "") : json(response, { error: "run not found" }, 404);
      }

      const setupLogsMatch = /^\/api\/runs\/(\d+)\/setup-logs$/.exec(url.pathname);
      if (request.method === "GET" && setupLogsMatch) {
        const run = await input.store.getRun(Number(setupLogsMatch[1]));
        return run ? text(response, run.setup_logs ?? "") : json(response, { error: "run not found" }, 404);
      }

      const promptMatch = /^\/api\/runs\/(\d+)\/prompt$/.exec(url.pathname);
      if (request.method === "GET" && promptMatch) {
        const run = await input.store.getRun(Number(promptMatch[1]));
        return run ? text(response, run.prompt) : json(response, { error: "run not found" }, 404);
      }

      const errorMatch = /^\/api\/runs\/(\d+)\/error$/.exec(url.pathname);
      if (request.method === "GET" && errorMatch) {
        const run = await input.store.getRun(Number(errorMatch[1]));
        return run ? text(response, JSON.stringify(run.error ?? null, null, 2)) : json(response, { error: "run not found" }, 404);
      }

      const conversationMatch = /^\/api\/runs\/(\d+)\/conversation$/.exec(url.pathname);
      if (request.method === "GET" && conversationMatch) {
        const run = await input.store.getRun(Number(conversationMatch[1]));
        return run ? json(response, run.conversation ?? null) : json(response, { error: "run not found" }, 404);
      }

      json(response, { error: "not found" }, 404);
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  await new Promise<void>((resolve) => server.listen(input.config.port, input.config.host, resolve));
  const address = server.address() as AddressInfo;
  const host = input.config.host === "0.0.0.0" ? "127.0.0.1" : input.config.host;
  return {
    url: `http://${host}:${address.port}/runs`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function renderRunsPage(input: { runs: AgentRunRow[]; stats: WorkerStats; config: ServiceConfig }): string {
  const rows = input.runs.map(runRow).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentRunner Runs</title>
  <style>
    body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f7f8fa; }
    header { padding: 20px 24px 12px; background: #fff; border-bottom: 1px solid #d9dee8; }
    h1 { margin: 0 0 12px; font-size: 20px; letter-spacing: 0; }
    .stats { display: flex; gap: 10px; flex-wrap: wrap; }
    .stat { padding: 6px 10px; border: 1px solid #d9dee8; border-radius: 6px; background: #fbfcfe; }
    main { padding: 18px 24px; overflow-x: auto; }
    table { width: 100%; min-width: 1120px; border-collapse: collapse; background: #fff; border: 1px solid #d9dee8; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #e6eaf0; text-align: left; vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; color: #59657a; background: #f1f4f8; letter-spacing: 0; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-word; }
    .status { font-weight: 600; }
    .status-running { color: #0b65c2; }
    .status-succeeded { color: #197044; }
    .status-failed { color: #b42318; }
    .status-retry { color: #7a5b00; }
    .muted { color: #667085; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; min-width: 172px; }
    button, .link-button { border: 1px solid #bcc5d3; background: #fff; color: #172033; border-radius: 5px; padding: 4px 8px; cursor: pointer; text-decoration: none; font: inherit; white-space: nowrap; }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); align-items: center; justify-content: center; padding: 24px; }
    .modal { width: min(960px, calc(100vw - 48px)); max-height: 84vh; overflow: auto; background: #fff; border-radius: 8px; box-shadow: 0 20px 50px rgba(16, 24, 40, 0.2); }
    .modal header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #d9dee8; }
    .modal h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
    .modal-content { padding: 16px; }
    .modal-content pre { margin: 0; background: #101828; color: #eef2f7; padding: 12px; overflow: auto; border-radius: 6px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>AgentRunner Runs</h1>
    <div class="stats">
      <span class="stat">Active: <strong>${input.stats.active}</strong></span>
      <span class="stat">Queued: <strong>${input.stats.queued}</strong></span>
      <span class="stat">Available workers: <strong>${input.stats.availableWorkers}</strong></span>
      <span class="stat">Max workers: <strong>${input.stats.maxWorkers}</strong></span>
      <span class="stat">Provider mode: <strong>${escapeHtml(input.config.agentProvider)}</strong></span>
      <span class="stat">Worktrees: <strong>${escapeHtml(input.config.git.createWorktrees)}</strong></span>
      <span class="stat">Table: <strong>${escapeHtml(`${input.config.databaseSchema}.${input.config.databaseTable}`)}</strong></span>
    </div>
  </header>
  <main>
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>UID</th>
          <th>Provider</th>
          <th>Mode</th>
          <th>Model</th>
          <th>Priority</th>
          <th>Attempts</th>
          <th>Link</th>
          <th>Workspace</th>
          <th>Timing</th>
          <th>Message</th>
          <th>Artifacts</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="12" class="muted">No runs yet.</td></tr>`}</tbody>
    </table>
  </main>
  <div id="modalBackdrop" class="modal-backdrop" role="dialog" aria-modal="true">
    <section class="modal">
      <header>
        <h2 id="modalTitle"></h2>
        <button type="button" onclick="closeModal()">Close</button>
      </header>
      <div id="modalContent" class="modal-content"></div>
    </section>
  </div>
  <script>
    async function openText(title, url) {
      const backdrop = document.getElementById('modalBackdrop');
      const titleNode = document.getElementById('modalTitle');
      const content = document.getElementById('modalContent');
      titleNode.textContent = title;
      content.innerHTML = '<p class="muted">Loading...</p>';
      backdrop.style.display = 'flex';
      const response = await fetch(url);
      const body = response.ok ? await response.text() : 'Unable to load content.';
      content.innerHTML = '<pre></pre>';
      content.querySelector('pre').textContent = body;
    }
    function closeModal() {
      document.getElementById('modalBackdrop').style.display = 'none';
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeModal();
    });
  </script>
</body>
</html>`;
}

function runRow(run: AgentRunRow): string {
  return `<tr>
    <td><span class="status status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
    <td><strong>${escapeHtml(run.uid)}</strong><br><code>#${run.id}</code></td>
    <td>${escapeHtml(run.agent_provider ?? "")}</td>
    <td>${escapeHtml(run.agent_mode ?? "")}</td>
    <td>${escapeHtml(run.model_name ?? "")}<br><span class="muted">${escapeHtml(run.reasoning_effort ?? "")}</span></td>
    <td>${run.priority}</td>
    <td>${run.attempts ?? 0}/${run.num_retries ?? 0}</td>
    <td>${run.link ? `<a href="${escapeHtml(run.link)}">Open</a>` : `<span class="muted">None</span>`}</td>
    <td>
      <div><code>${escapeHtml(run.branch_name ?? "")}</code></div>
      <div class="muted">${escapeHtml(run.base_branch ?? "")}</div>
      <div><code>${escapeHtml(run.worktree_path ?? run.repo_path ?? "")}</code></div>
      ${run.cleanup_note ? `<div>${escapeHtml(run.cleanup_note)}</div>` : ""}
    </td>
    <td>
      <div>Created: ${escapeHtml(formatDate(run.created_at))}</div>
      <div>Started: ${escapeHtml(formatDate(run.started_at ?? null))}</div>
      <div>Finished: ${escapeHtml(formatDate(run.finished_at))}</div>
    </td>
    <td>${escapeHtml(truncate(run.last_message ?? "", 180))}</td>
    <td><div class="actions">
      <button type="button" onclick="openText('Prompt', '/api/runs/${run.id}/prompt')">Prompt</button>
      <button type="button" ${run.error ? "" : "disabled"} onclick="openText('Error', '/api/runs/${run.id}/error')">Error</button>
      <button type="button" ${run.logs ? "" : "disabled"} onclick="openText('Logs', '/api/runs/${run.id}/logs')">Logs</button>
      <button type="button" ${run.setup_logs ? "" : "disabled"} onclick="openText('Setup logs', '/api/runs/${run.id}/setup-logs')">Setup</button>
      <a class="link-button" href="/api/runs/${run.id}/conversation">Conversation</a>
    </div></td>
  </tr>`;
}

function json(response: http.ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

function html(response: http.ServerResponse, value: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(value);
}

function text(response: http.ServerResponse, value: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value instanceof Date ? value.toISOString() : value;
}
