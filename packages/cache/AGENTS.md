# Cache Package Guidance

## Scope

This package owns bounded cache-aside behavior, memory and Redis backends, presets, and cache telemetry events. Its only required runtime dependency is `@ooopsstudio/core`.

## Required workflow

- Run `pnpm --filter @ooopsstudio/cache test`, `typecheck`, `build`, and `size` for behavior changes.
- Run `test:integration` when changing Redis scripts, record encoding, or atomic mutation behavior.
- Add adversarial tests for bounds, retries, races, hostile input, and shutdown changes.

## Boundaries

- Use core contracts and optional ports; do not depend on concrete logging, errors, metrics, tracing, or lifecycle packages.
- Keep Redis structural. Do not add a required Redis client dependency or a production memory fallback.
- Keep cross-domain observability mappings outside this package. The public attachment exposes bounded raw events only.
- Preserve immutable snapshots, bounded cardinality, atomic Redis semantics, and retryable finalization.

## Avoid

- Do not expose backend queues, mutable records, timers, or internal telemetry controllers.
- Do not add SDK key-builder helpers here; those belong to the future SDK migration.
- Do not weaken URL/data validation, limits, or package export boundaries to simplify a test.
