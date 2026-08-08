# Events

Durable, schema-validated event publication and consumption. Events is intentionally not a workflow engine or a generic in-process event bus.

## Public paths

- `@ooopsstudio/events` — registration and application contracts
- `events/development`, `events/production`, `events/custom` — async presets
- `events/stores/memory`, `events/stores/postgres` — composed backends
- `events/backends/custom` — privileged custom persistence extension contracts
- `events/admin` — safe administrative projections
- `events/migrations/postgres` — deployment-owned schema artifacts
- `events/transports/http`, `events/transports/kafka`, `events/transports/nats` — lazy destinations
- `events/transports/custom` — custom destination extension contracts

Definitions and consumers must be registered before `start()`. A definition may select at most one named outbound destination. Consumer retries are persisted in the outbox; handlers do not own retry policy.

Production requires a durable backend with a successful read-only compatibility check. Worker and combined roles additionally require an atomic inbox. Runtime code never executes DDL.

Custom backends must round-trip every `StoredEventRecord` field. In particular, preserve `payloadValidated`; it prevents an already-normalized schema payload from being transformed again during delivery while legacy records without the marker remain validated on read.

`flush()` waits only for work accepted by the current process and destination flushes. It does not promise that a durable cross-process backlog is empty. `shutdown()` closes admission and is retryable from `draining` after bounded finalization failure.

The SDK retains `defineEvent()`, `defineConsumer()`, JSON Schema and AsyncAPI generation. Workflows, runtime schema persistence, local subscribers, health polling and detailed persistence status are deliberately absent.
