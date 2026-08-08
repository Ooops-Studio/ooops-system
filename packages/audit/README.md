# `@ooopsstudio/audit`

Immutable, redacted audit evidence with bounded storage and a stable SHA-256 integrity chain.

## Installation

```bash
pnpm add @ooopsstudio/core @ooopsstudio/audit
```

The package is ESM-only and requires Node.js 20 or newer. PostgreSQL production
support accepts a structural pooled-client interface; `pg` is not a runtime
dependency. Mutation results must expose an accurate `rowCount`, matching the
standard `pg` result contract.

Production compatibility requires permanent heap tables with the versioned
columns, constraints and indexes. Additional application columns must be
nullable and have no default. Row-level security, inheritance, generated
columns, rewrite rules, table triggers and additional write-changing defaults,
constraints or indexes are rejected fail-closed. Audit mutation
transactions also upgrade `synchronous_commit=off` to `on` without weakening
stronger replication modes. Every owned or caller-owned transaction is bound
to the verified PostgreSQL database and cluster identity. A rejected transactional batch rolls
back to its audit savepoint; if that cleanup cannot be confirmed, the adapter
aborts the whole caller transaction rather than permit a partial audit commit.
Owned transactions put `pg_catalog` before the explicitly positioned
`pg_temp` in their transaction-local search path. A caller-owned transaction
is rejected unless `pg_catalog` resolves first, preventing application
functions, operators, or temporary types from shadowing PostgreSQL durability
and locking logic.

## Entry points

- `@ooopsstudio/audit` registers a selected preset in the shared container.
- `@ooopsstudio/audit/development` uses bounded in-memory storage.
- `@ooopsstudio/audit/production` requires a compatible PostgreSQL store.
- `@ooopsstudio/audit/custom` accepts explicit store capabilities.
- `@ooopsstudio/audit/admin` exports privileged compliance contracts.
- `@ooopsstudio/audit/observability` exposes one fail-open event attachment.
- `@ooopsstudio/audit/public/types` exports public audit and store types.

```ts
import {createProductionAudit} from '@ooopsstudio/audit/production'

const runtime = await createProductionAudit({postgres: {client: pool}})

await runtime.audit.record({
	idempotencyKey: commandId,
	eventType: 'account.permission.changed',
	category: 'access',
	action: 'grant',
	actor: {kind: 'user', id: actorId},
	target: {entityType: 'account', entityId: accountId},
	outcome: 'succeeded',
	sensitivity: 'high'
})
```

Normal writes, caller-owned transactional writes, and privileged admin operations are separate capabilities. Production never falls back to memory and never creates or migrates database objects at runtime. Applications own versioned PostgreSQL migrations; startup performs read-only compatibility verification for schema version 5.

Raw idempotency keys are hashed and never returned. Queries, records, batches, exports, redaction traversal, retention plans, and in-memory identity reservations are bounded. Explicit pruning retains tombstones and sealed partition heads so deleted evidence identities and chains cannot be reused.

The integrity chain detects accidental corruption and reordering. It does not protect against an attacker who can rewrite both records and hashes.

## License

MIT.
