# Tracing Package Guidance

- Depend at runtime only on `@ooopsstudio/core`; use logging, errors, metrics, and lifecycle through optional core ports.
- Preserve W3C propagation, bounded span admission, mandatory redaction, delivery ownership, and retryable shutdown semantics.
- Keep root registration lightweight. Console, OTLP, batching, and resilience implementations belong only in their explicit preset paths.
- Treat collector URLs, headers, baggage, attributes, events, links, and custom exporters as hostile input and keep all work bounded.
- Add adversarial and concurrency tests for propagation, delivery barriers, partial exports, DI rollback, and late-settling exporters.
