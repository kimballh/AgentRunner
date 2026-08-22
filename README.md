# AgentRunner

Postgres-backed local agent job runner for Codex and Claude Code.

## Setup

Requires Node.js 20 or newer.

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

To link the current source checkout globally:

```bash
npm link
```

This exposes the `agentrunner` command on your `PATH`. Because the global
command points at `./dist/cli.js`, run `npm run build` again after changing the
TypeScript source.

If you prefer installing a global copy instead of a symlink, run:

```bash
npm install --global .
```

## Use in a Project

From any project where you want AgentRunner to manage jobs, create a local
`.env`:

```bash
AGENTRUNNER_DATABASE_URL=postgres://user:password@host/db
```

Optional project config lives at `./agentrunner_config.toml`; see
`agentrunner_config.example.toml`.

Then initialize and run AgentRunner from that project directory:

```bash
agentrunner setup-db
agentrunner check
agentrunner run
```

## Commands

```bash
agentrunner print-ddl
agentrunner setup-db
agentrunner check
agentrunner run
```

If an existing table is incompatible and setup cannot migrate it cleanly, you can
drop and recreate the configured table after the first setup failure:

```bash
agentrunner setup-db --force
```

After `run` starts, it prints a local dashboard URL:

```text
AgentRunner dashboard: http://127.0.0.1:49321/runs
```

Running rows include a **Stop** action. Cancellation asks the agent process to
exit gracefully, force-kills it after a short timeout if necessary, and records
the run as `cancelled` without consuming its configured retries. Existing logs,
session metadata, and worktree metadata are retained.

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
- `num_workers`: concurrent workers per enabled provider. With
  `agent_provider = "both"`, setting this to `4` permits up to four Codex and four Claude runs
  concurrently (eight total).
- `poll_frequency_ms`, `database_schema`, `database_table`, `host`, and `port`.
- `preflight_retries` defaults to `2` retries for transient Git, database, and
  system failures. `preflight_retry_delay_ms` defaults to `1000` and is used as
  the base for linear backoff.
- `[git]` controls execution workspaces. By default `create_worktrees = "auto"`
  creates isolated worktrees when AgentRunner starts inside a Git repo and keeps
  cwd execution outside Git repos.

Provider defaults are configured under `[codex]` and `[claude]`, including
default model and reasoning effort.

CLI args use the same names with dashes, for example:

```bash
agentrunner run \
  --agent-provider both \
  --default-agent-provider codex \
  --num-workers 2 \
  --poll-frequency 60000
```

Worktree options can be set in TOML or overridden on the CLI:

```bash
agentrunner run \
  --create-worktrees auto \
  --base-branch origin/main \
  --worktree-dir .worktrees \
  --max-worktrees 25
```

When worktrees are enabled, AgentRunner fetches the configured remote, creates a
per-run branch and worktree from the queued row's `base_branch` when present (or
the configured/upstream base branch otherwise), runs setup, then executes Codex
or Claude inside that worktree. Remote-tracking bases such as
`origin/project/workflow-automation` are therefore refreshed before each
worktree is created. Setup defaults to `[setup].script` in
`.codex/environments/environment.toml` when present. You can override it with
`[git].setup_script`, `[git].setup_command`, or disable it with `--no-setup`.

## Job Table

`setup-db` creates the requested `agent_runs` table and adds operational columns
for locking, heartbeats, result JSON, exit codes, and workspace metadata.
Workers claim jobs with `FOR UPDATE SKIP LOCKED` from rows whose status is
`queued` or `retry`, ordered by `priority desc, created_at asc`.

Set a queued row's `workspace_mode` to `cwd` to run that job directly in the
AgentRunner process's startup directory without fetching, creating a branch, or
creating a worktree. Set it to `worktree` to force a per-run worktree even when
the global `[git].create_worktrees` setting is `never`. Leave it `NULL` to use
the global setting. CWD mode also skips workspace setup and retained-session
reuse. Multiple CWD jobs share the same directory, so reserve this mode for
read-only or otherwise concurrency-safe tasks.

Set a queued row's `reuse_session` column to `true` to request best-effort
continuation of the newest successful run with the same `uid`. AgentRunner only
reuses a retained provider session whose Git worktree still exists and is
registered. It inherits the provider, mode, model, and reasoning effort from
that session, fetches the configured remote, and fast-forwards the checked-out
branch only when the worktree is clean and has an upstream. Workspace setup is
skipped so the retained environment remains intact.

Reuse is opportunistic. Missing sessions, removed or invalid worktrees, and
concurrent use of the same session fall back to a fresh worktree and session.
The row records the result in `session_id`, `reused_from_run_id`, and
`reuse_fallback_reason`. A partial unique index prevents two active jobs from
resuming the same session concurrently.

## Development

When working inside this repository, you can run the TypeScript entrypoint
without rebuilding:

```bash
npm run dev -- run
```
