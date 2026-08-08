# Profiling Package Guidance

- Depend at runtime only on `@ooopsstudio/core`; use logging, errors, metrics, tracing, and lifecycle through optional core ports or the narrow observability entrypoint.
- Keep root registration lightweight. Inspector, Pyroscope, and raw-profile exporters belong only in explicit subpaths.
- Preserve CPU-only profiling, process-wide ownership, bounded captures, mandatory sanitization, and retryable finalization.
- Treat labels, resources, profile payloads, exporters, providers, URLs, environment values, and container implementations as hostile input.
- Add adversarial, concurrency, packed-artifact, and real provider integration tests for behavior changes.
