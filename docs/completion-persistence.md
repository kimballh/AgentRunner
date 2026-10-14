# Completion persistence and deployment

When an agent returns exit code 0, saving its result is a separate operation.
A journal or database error cannot replace the result with an execution failure,
consume an execution retry, or invoke the provider again. The runner retains
the full successful result and retries only completion persistence.

## Durable execution and completion boundaries

Before invoking a provider, the worker commits `execution_started=true` in the
current attempt's metadata while holding its job lock. It refreshes the
heartbeat in the same transaction and requires the current worker, attempt,
running status and absence of a cancellation request. An unacknowledged or
lost lease cannot start a provider. The marker is intentionally conservative:
an acknowledged start followed by a crash before provider invocation is still
an uncertain execution requiring inspection.

After exit code 0, the runner snapshots and redacts the full result, adds the
expected final lifecycle sequence, and writes an immutable completion receipt
before awaiting journal drain or another worker's completion transaction. The
receipt includes its version, run ID, attempt, original worker, completion
time, result and SHA-256 digest. A receipt file and its directory entries are
fsynced. The atomic publish does not overwrite another writer's evidence.

Receipts live below
`<startup cwd>/.agentrunner-completions/<queue identity hash>/`. The hash uses
database host, port, database name, schema and table, excluding credentials and
transport options. Directories and files must be owned by the service user and
private (0700/0600); symlink receipts and spool directories are rejected. Add
`.agentrunner-completions/` to the managed project's ignore rules before rollout
and retain this directory across upgrades. Keep the startup cwd and queue
endpoint identity stable when recovering outstanding receipts.

Completion atomically updates the exact job and attempt and stores the digest
in existing attempt metadata. `RETURNING` includes only the status, ownership,
configuration and workspace fields required to finish history. Large logs,
conversation, prompt and webhook data are not returned. Full logs/conversation
snapshots are still written for existing readers; this patch does not redesign
large output storage or eliminate database timeouts.

If a write or COMMIT acknowledgement is lost, the completion path queries the
current job and exact attempt again. Only a matching original worker, current
attempt, terminal job/attempt status and digest acknowledges success. Otherwise
the same immutable receipt may retry while the lease remains valid. A changed
attempt, worker or conflicting terminal outcome retains the receipt for
inspection without overwriting the current job. Concurrent replay of the same
receipt is idempotent; different receipts cannot replace an applied outcome.

Cancellation is checked atomically in the completion UPDATE. A cancellation
request wins the queue status, while the successful result and exit code 0 are
retained. Cancellation cannot undo external actions that already occurred.

The final lifecycle marker is checked with the journal's primary key to report
`output_complete` accurately. The full receipt may be recovered even if a crash
left the journal incomplete. Locally active journal drain finishes before a
background completion save; a separate process recovering a shared spool may
observe the conservative incomplete journal state.

## Retry bounds and restart recovery

Each persistence round makes at most three completion attempts, with 100 ms
and 200 ms delays and a fresh readback after each uncertain attempt. Existing
15-second server and 20-second client query deadlines remain unchanged.
These are per-query and per-round bounds, not an overall transaction-duration
guarantee.

After exhaustion, the successful result remains in memory and on disk whenever
spooling succeeded. New claims pause in that process. The periodic poll starts
another bounded persistence round no more often than `poll_frequency_ms` (with
a minimum 1-second interval); newly completed active runs may join the current
round. Only spooling, completion SQL and readback are repeated. Background
rounds can continue until storage recovers; the provider is never part of them.

Startup replays local receipts before stale recovery, dashboard startup or
worker claims. Applied success/cancellation receipts are removed durably.
Unresolved, stale, conflicting, malformed or incomplete receipts prevent new
worker startup. They are not silently discarded, selected by filename order or
converted into execution retries.

Stale recovery holds a running attempt with an execution marker, executing or
finalizing phase, or terminal lifecycle evidence as `completion_pending`,
preserving its attempt and original lease. Pending jobs are excluded from
claims, session/worktree reuse and cleanup. Manual queue retry and claims also
reject durable successful terminal evidence. Confirmed pre-execution workspace
failures and explicit nonzero executor failures retain existing retry behavior.

## Operational limits

A receipt is limited to 64 MiB. Disk exhaustion, permission failures, fsync
errors or oversized output leave success retained in memory and prevent new
claims. A stable per-receipt temporary filename bounds partial artifacts on
repeated failures; partial writes remain for inspection. Concurrent duplicate
writers wait at most one second for the first atomic publish before failing
closed. A later round can acknowledge the completed receipt.

A process crash before durable spooling can lose the full output. The committed
execution marker prevents automatic replay, but it cannot reconstruct missing
output. A host-local spool is not visible to other hosts; those workers hold
the expired marked attempt until evidence is available. A pending attempt
without a valid receipt requires operator investigation. Do not delete its
workspace, clear its evidence, or launch another agent merely to resolve a
bookkeeping state. Exactly-once external actions across arbitrary failures need
idempotency support from the external systems as well.

Legacy workers did not commit the new execution-start marker. Their journal
phase could lag actual execution. The stronger crash boundary applies to runs
started by this version; upgrading cannot retroactively prove that a legacy
workspace-phase attempt performed no external work.

## Coordinated deployment

No new table, column or migration is required. This version uses the existing
attempt metadata and journal tables and a new value in the unconstrained text
status column. The existing active-session partial index does not include
`completion_pending`; the new runtime claim/reuse guards preserve reservations
for normal supported queue operations. Direct database writes bypassing those
guards are outside the supported queue API.

All workers sharing a queue must be upgraded together. Older workers ignore
pending reservations during cleanup/reuse and may requeue uncertain executions.
Arrange a separately approved coordinated drain/stop, preserve each worker's
cwd and spool, review any outstanding executions, install/build this version,
then restart the upgraded workers. Do not overlap old and new worker versions.
No migration or historical-job reconciliation is needed for this rollout.

This implementation has not been deployed. Running services, live configuration,
credentials, database schema and historical failed-job records remain unchanged.

## Isolated verification

The completion tests use in-memory providers/stores or a disposable PostgreSQL
database with synthetic jobs. They cover timeout at the first UPDATE, rollback
at attempt save, transient connection failures, lost COMMIT acknowledgement,
concurrent receipts, cancellation, stale workers and reused worker IDs, bounded
exhaustion, disk failure, restart recovery, incomplete journals, receipt
permissions/integrity, and workspace/session reservations. Service regressions
run the actual worker loop with a mocked provider and assert one invocation.

Run `npm run check`, `npm run build` and `npm test`. To include PostgreSQL/MCP
integration coverage, set `TEST_DATABASE_URL` to a disposable local test
database. Those tests create/drop synthetic schemas and the MCP fixture uses a
generated fake provider executable; never point this variable at a live queue.
