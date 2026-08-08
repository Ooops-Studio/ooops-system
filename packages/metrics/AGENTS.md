# Metrics Package Guidance

- Depend at runtime only on `@ooopsstudio/core`.
- Keep logging, errors, lifecycle, and tracing optional through core ports; never import their concrete packages.
- Preserve cardinality, queue, byte, retry, timeout, shutdown, transport, and SSRF bounds when changing behavior.
- Keep provider entrypoints independently tree-shakeable and do not expose mutable recorder/exporter internals.
- Add adversarial tests for caller-controlled objects and validate the packed package before release.
