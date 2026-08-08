# Performance Package Guidance

- Depend at runtime only on `@ooopsstudio/core`; use errors, logging, metrics, tracing, and lifecycle through optional core ports or the narrow observability entrypoint.
- Keep runtime monitors internal to presets. Public entrypoints must not expose monitor ownership, queues, exporters, or mutable handler state.
- Preserve bounded cardinality, delivery, retries, shutdown, hostile-input protection, and HTTPS/network validation.
- Keep browser RUM and Web Vitals out of this server package.
- Add adversarial, concurrency, packed-artifact, and real HTTPS integration tests for behavior changes.
