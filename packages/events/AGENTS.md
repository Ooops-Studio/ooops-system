# Events Package Guidance

## Scope

This package owns durable outbox/inbox event publication, consumption, stores, transports, and presets. Its only runtime dependency is `@ooopsstudio/core`; runtime telemetry remains private until a real bridge consumer exists.

## Required workflow

- Run unit tests, integration tests, typecheck, build, size, and packed-artifact checks for behavior or export changes.
- Add adversarial coverage for hostile inputs, leases, retries, concurrency, registration, storage, and transport security.
- Keep normal, transactional, and administrative capabilities separate.

## Boundaries

- Use structural PostgreSQL, Kafka, and NATS clients; do not add required client libraries.
- Keep cross-domain logging, errors, metrics, and tracing mappings in a bridges package.
- Production must require durable compatible storage and must never run DDL or silently fall back to memory.

## Avoid

- Do not turn this package into an in-process event bus or workflow engine.
- Do not expose mutable queues, leases, inbox records, transport state, or raw persistence internals from root exports.
- Do not weaken payload, batch, cardinality, timeout, SSRF, destination, or concurrency bounds.
