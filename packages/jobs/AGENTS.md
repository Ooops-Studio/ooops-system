# Jobs Package Guidance

## Scope

This package owns bounded task scheduling, durable background execution, backends, migrations, and presets. Its only runtime dependency is `@ooopsstudio/core`; runtime telemetry remains private until a real bridge consumer exists.

## Required workflow

- Run unit tests, integration tests, typecheck, build, size, and packed-artifact checks for behavior or export changes.
- Add adversarial coverage for hostile inputs, leases, retries, cancellation, concurrency, registration, storage, and transport boundaries.
- Keep the normal and administrative capabilities separate.

## Boundaries

- Use structural Redis and PostgreSQL clients; do not add required client libraries.
- Keep cross-domain logging, errors, metrics, and tracing mappings in a bridges package.
- Production must require durable compatible storage and must never run DDL or silently fall back to memory.

## Avoid

- Do not turn this package into a workflow orchestration engine.
- Do not expose mutable queues, leases, scheduler state, backend records, or raw persistence internals from root exports.
- Do not weaken payload, byte, batch, queue, timer, cardinality, lease, or concurrency bounds.
