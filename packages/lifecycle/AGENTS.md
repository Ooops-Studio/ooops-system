# Lifecycle Package Guidance

- Depend at runtime only on `@ooopsstudio/core`.
- Keep logging, errors, metrics, and tracing optional through core ports; never import their concrete packages.
- Preserve startup ordering, health thresholds, hook bounds, readiness semantics, and retryable shutdown ownership.
- Keep Node process ownership isolated to the explicit `node` entrypoint. Never install listeners from browser-safe entrypoints or call `process.exit()`.
- Add adversarial tests for caller-controlled values, lifecycle races, rollback, hung work, and listener cleanup.
