# Resilience Package Guidance

## Scope

This package owns bounded timeout, retry, circuit-breaker, bulkhead, coalescing, presets, and raw observability events. Its only runtime dependency is `@ooopsstudio/core`.

## Required workflow

- Run package tests, integration tests, typecheck, build, and size checks for behavior changes.
- Add adversarial coverage for bounds, hostile inputs, cancellation, concurrency, timers, and registration changes.
- Validate packed public entrypoints when exports change.

## Boundaries

- Use optional core ports; do not depend on concrete lifecycle, logging, errors, metrics, tracing, or performance packages.
- Keep engines and state package-internal. Cross-domain telemetry mappings belong in a bridge package.
- Preserve immutable bootstrap policies, fail-closed capacity behavior, cancellation propagation, and retryable bounded shutdown.

## Avoid

- Do not expose mutable stores, queues, registries, classifiers, fallbacks, timers, or execution internals.
- Do not reintroduce cache, rate-limit, distributed-idempotency, recovery-manager, builder, or legacy APIs.
- Do not weaken state, cardinality, queue, retry-budget, timeout, or metadata bounds.
