# AgentRunner

Postgres-backed local agent job runner for Codex and Claude Code.

## Setup

```bash
npm install
npm run build
```

Create a local `.env` in the project where you run the service:

```bash
AGENTRUNNER_DATABASE_URL=postgres://user:password@host/db
```

Optional project config lives at `./agentrunner_config.toml`; see
`agentrunner_config.example.toml`.

## Commands

```bash
npm run dev -- print-ddl
npm run dev -- setup-db
npm run dev -- check
npm run dev -- run
```

If an existing table is incompatible and setup cannot migrate it cleanly, you can
drop and recreate the configured table after the first setup failure:

```bash
npm run dev -- setup-db --force
```

After `run` starts, it prints a local dashboard URL:

```text
AgentRunner dashboard: http://127.0.0.1:49321/runs
```

## Configuration

Config precedence is CLI args, env vars, TOML, then defaults. `$cwd/.env` is
loaded before config values are resolved.

Key settings:

- `agent_provider`: `codex`, `claude`, or `both`; default `both`.
- `default_agent_provider`: used only when `agent_provider = "both"` and a row
  has no `agent_provider`; default `codex`.
- `agent_mode`: `exec` or `app-server`; applies to Codex.
- `database_url_env_var`: env var name to read the database URL from; default
  `AGENTRUNNER_DATABASE_URL`.
- `num_workers`, `poll_frequency_ms`, `database_schema`, `database_table`,
  `host`, and `port`.
- `[git]` controls execution workspaces. By default `create_worktrees = "auto"`
  creates isolated worktrees when AgentRunner starts inside a Git repo and keeps
  cwd execution outside Git repos.

Provider defaults are configured under `[codex]` and `[claude]`, including
default model and reasoning effort.

CLI args use the same names with dashes, for example:

```bash
npm run dev -- run \
  --agent-provider both \
  --default-agent-provider codex \
  --num-workers 2 \
  --poll-frequency 60000
```

Worktree options can be set in TOML or overridden on the CLI:

```bash
npm run dev -- run \
  --create-worktrees auto \
  --base-branch origin/main \
  --worktree-dir .worktrees \
  --max-worktrees 25
```

When worktrees are enabled, AgentRunner fetches the configured remote, creates a
per-run branch and worktree from the base branch, runs setup, then executes
Codex or Claude inside that worktree. Setup defaults to `[setup].script` in
`.codex/environments/environment.toml` when present. You can override it with
`[git].setup_script`, `[git].setup_command`, or disable it with `--no-setup`.

## Job Table

`setup-db` creates the requested `agent_runs` table and adds operational columns
for locking, heartbeats, result JSON, exit codes, and workspace metadata.
Workers claim jobs with `FOR UPDATE SKIP LOCKED` from rows whose status is
`queued` or `retry`, ordered by `priority desc, created_at asc`.
