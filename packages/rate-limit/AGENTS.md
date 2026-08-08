# Rate-Limit Package Guidance

## Scope

This package owns bounded rate-limit policy evaluation, memory and Redis engines, HTTP projections, presets, and raw observability events. Its only required runtime dependency is `@ooopsstudio/core`.

## Required workflow

- Run `pnpm --filter @ooopsstudio/rate-limit test`, `typecheck`, `build`, and `size` for behavior changes.
- Run `test:integration` when changing Redis scripts, atomic consumption, expiry, or rollback-clock behavior.
- Add adversarial tests for bounds, hostile input, concurrency, timeouts, and registration changes.

## Boundaries

- Use core contracts and optional ports; do not depend on concrete logging, errors, metrics, tracing, or lifecycle packages.
- Keep Redis structural and atomic. Do not add a required Redis client dependency or production memory fallback.
- Keep cross-domain observability mappings outside this package; expose bounded raw events only.
- Preserve immutable policy/request snapshots, bounded pending work, explicit fail-open/fail-closed behavior, and retryable shutdown.

## Avoid

- Do not expose engine maps, Redis scripts, telemetry controllers, or mutable runtime state.
- Do not weaken numeric precision, key, policy, batch, timeout, or payload limits.
- Do not add endpoint-specific policy builders; applications own policy naming and composition.
