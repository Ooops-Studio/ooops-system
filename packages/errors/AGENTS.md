# Errors Package Guidance

- Depend at runtime only on `@ooopsstudio/core`.
- Keep logging, metrics, tracing, lifecycle, and cache integrations optional
  through core ports; do not import concrete sibling packages or bridges.
- Preserve redaction, hostile-input isolation, bounded admission, retryable
  finalization, and Sentry transport tests when changing behavior.
- Keep Sentry delivery on its explicit subpath and out of the root and preset
  bundles.
- Never expose raw nested errors, secrets, credentials, or unredacted caller
  values through diagnostics or observability callbacks.
