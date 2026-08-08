# Jobs Service

`@ooopsstudio/jobs` is a focused task scheduler with development,
production, and custom presets.

There are no minimal/testing presets or public test helpers.

```ts
await registerJobs(container, {preset: 'development'})

await registerJobs(container, {
  preset: 'production',
  options: {backend: createRedisJobsBackend({redis})}
})
```

The application port handles registration, enqueue, schedules, cancellation,
bounded status, and lifecycle. Operational listing, queue controls, manual retry, and
dead-letter requeue are exposed separately through `jobs/admin` and
`TOK.JobsAdmin`.

Production requires an explicit durable Redis, SQL, or custom backend. Backend
errors are fail-closed and never fall back to memory. Redis uses cluster-safe
hashes and sorted-set indexes with atomic Lua claims. SQL uses native rows,
indexed due queries, and `FOR UPDATE SKIP LOCKED` claims.

The Redis backend bounds each native bucket to 10,000 runs, schedules, dead
letters, and idempotency claims. Every built-in backend admits at most 1,000
distinct queues, including paused queues, so admin queue projections
remain bounded. Legacy
migration validates the same limits before its first write. Due schedule windows
are committed as one preflighted, idempotent Lua batch, so a lost response can be
retried without creating duplicate runs. Claimed schedules are content-bound and
the complete batch is verified before its first write; malformed or structurally
invalid due schedules are quarantined from the due index without hiding their
stored admin record or wedging healthy schedules. Redis emits at most eight generated
runs in one schedule-trigger batch; larger catch-up windows advance over later
ticks so valid large payloads cannot exceed the Lua request limit or starve.
When a bounded memory or Redis backend has only partial run, queue, or byte
capacity left, due scheduling commits the leading prefix that fits instead of
repeatedly rejecting the complete batch.
Queue-overlap schedules with a live run retain their original due time but are
excluded or briefly deferred from the due head, so they cannot starve later
schedules while preserving their eventual misfire decision.
Due-run claims use a global priority/run-time index plus payload-free runnable
metadata. A maximum 1,024-run claim therefore scans the bounded ready population
once without decoding payloads for paused or task-saturated work.
Workers claim runs and trigger schedules only for tasks registered in their
local runtime, so multiple task-specialized workers can safely share one backend
namespace.
Schedule,
dead-letter, terminal, ready, run-order, running-count, and queue-stat indexes are
rebuilt for existing native namespaces in byte-bounded batches that yield between
Lua calls. Malformed records are isolated from ready and queue-stat rebuilds;
running-count rebuilds remain fail-closed because undercounting a possibly active
run would violate concurrency admission. Stale-lease recovery repairs malformed
running metadata without blocking healthy leases, and retention quarantines corrupt
dead-letter relationships instead of wedging the terminal cleanup queue. Listings are indexed and response-byte bounded. Dead-letter listings
read payload-free summary metadata, so all 10,000 public entries remain visible
even when the retained requeue payloads are large. SQL uses the same payload-free
projection for dead-letter summaries and caps every other payload-bearing result
page so valid 1 MiB payloads cannot create a gigabyte-scale provider result before
validation.

Legacy snapshot data and the SQL schema must be migrated explicitly before creating a native backend:

```ts
import {migrateRedisJobsSnapshot} from '@ooopsstudio/jobs/migrations/redis'
import {migrateSqlJobsSnapshot} from '@ooopsstudio/jobs/migrations/sql'

await migrateRedisJobsSnapshot({redis, namespace: 'jobs:scheduler'})
await migrateSqlJobsSnapshot({sql, namespace: 'jobs:scheduler'})
```

Migration is idempotent and preserves the legacy snapshot unless
`deleteLegacySnapshot: true` is provided. Before destructive cleanup, migration
verifies the native SQL schema or semantic parity for every legacy Redis record.
Redis cleanup additionally compare-and-deletes the exact snapshot that was
verified, so a concurrent legacy write is preserved.
Production and custom retain terminal
runs for seven days by default; custom can override `terminalRetentionMs`.
Dead-letter retention removes the terminal run and its dead-letter sidecar
atomically, after any active enqueue idempotency claim expires. Maintenance still
runs when schedule, recovery, or claim stages fail, so bounded backends can free
capacity instead of remaining wedged by the failure that filled them. Each due
maintenance pass drains up to 100 bounded batches rather than one batch per
interval, preventing sustained terminal throughput from outpacing retention.
Development keeps terminal runs until shutdown.

The Redis integration suite is opt-in and runs against a real Redis container:

```sh
JOBS_REDIS_DOCKER_CONTAINER=ooops-jobs-redis-live \
  pnpm exec vitest run test/jobs/live/native-redis.integration.test.ts
```

The container name is supplied explicitly so normal unit runs never start,
modify, or depend on external infrastructure.

The PostgreSQL integration suite is also opt-in and uses a dedicated database:

```sh
JOBS_POSTGRES_URL=postgresql://jobs:jobs@127.0.0.1:5432/jobs \
  pnpm exec vitest run test/jobs/live/native-postgres.integration.test.ts
```

It verifies concurrent `SKIP LOCKED` claims, transaction rollback and the native
schema/index migration. The normal SQL backend performs read-only compatibility
validation and never runs DDL. Serialization/deadlock aborts during claim are retried in
a bounded transaction loop; all other backend failures remain fail-closed.
SQL concurrency admission counts every scalar `running` row conservatively,
including a row whose JSON projection is inconsistent, so storage corruption
cannot silently open an extra global or per-task execution slot.
Retention cleanup rechecks idempotency expiry on the row being deleted, so a
concurrent enqueue or dead-letter requeue cannot lose a newly renewed claim.
Terminal rows with invalid payloads or dead-letter relationships are quarantined
from SQL retention without deleting forensic data or rolling back cleanup of
healthy rows.

Jobs are executed at least once. Use explicit enqueue idempotency keys and make
external side effects idempotent. Workflow orchestration is intentionally outside
this service. If a backend commits but loses its response, the runtime confirms
the exact generated run or transition before returning or continuing; committed
enqueue, completion, retry, dead-letter, manual-trigger, and lease-renewal writes
therefore do not become duplicate work or false lease failures.

Shutdown first stops polling and drains active executions for five seconds. Jobs
that exceed that grace period are aborted and receive one final bounded drain
window. If they ignore cancellation, shutdown rejects instead of hanging and leaves
the runtime permanently draining. A later `shutdown()` continues unresolved cleanup
without reopening polling or admission. Schedule `replace` is unsupported because
application side effects cannot be safely interrupted; use `queue`, `skip`, or
custom-only `allow`.

Already accepted queue and admin mutations remain owned until their backend work
settles. Timed-out task handlers and lease renewals retain the same ownership;
handlers that ignore cancellation continue to occupy global and per-task
concurrency until they actually settle. Cancellation overflow point-reads are
generation-fenced, and a claim returned after initial startup has already failed
is released without invoking its handler.

Runtime timing values use non-negative integer milliseconds up to
`99_999_999_999_999`. Persisted numeric payload values and retry factors must
round-trip at 14 significant digits because Redis Lua `cjson` cannot preserve
greater precision. Durable lease durations must be at least 200 ms, priorities
are signed 32-bit integers, and retry delays are bounded to the Node timer range.
Queue lag calculations use the injected clock, which keeps development schedulers
deterministic.

Enqueue payloads and task outputs are validated as bounded JSON-compatible data:
at most 1 MiB, 32 levels and 10,000 structural nodes. Duplicate task registration, malformed
idempotency keys and unbounded cancellation reasons are rejected before backend
mutation. Persisted failures and backend status use stable diagnostic codes; raw
task/backend exception messages are never exposed through runs, dead letters, or
status snapshots. Jobs does not mutate lifecycle health or readiness.

Memory, Redis and SQL all implement lease fencing and stale-lease recovery.
Workers renew leases while a task is active, including the in-memory development
backend, so a long-running task cannot be reclaimed merely because it exceeded
the original lease duration.

Global and per-task concurrency are capped at 1,024, retry policies at 100
attempts, and all operational millisecond values remain within the safe Node
timer range.

Cron expressions use five fields. Steps on a concrete starting value follow
standard semantics: `5/15 * * * *` runs at minutes 5, 20, 35, and 50.
For `misfire: 'skip'`, lateness within two polling intervals is treated as normal
scheduler jitter; older due occurrences are skipped and the cadence advances.
