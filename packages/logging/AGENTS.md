# Logging Package Guidance

- Depend at runtime only on `@ooopsstudio/core`.
- Keep errors, metrics, lifecycle, and tracing integrations optional through
  core ports; do not import concrete service packages or bridges.
- Preserve redaction, delivery, retry, and sink failure tests when changing
  behavior.
- Add public entrypoints deliberately and validate the packed package before a
  release.
