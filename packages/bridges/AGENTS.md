# Bridges Package Guidance

- Own only explicit cross-domain mappings; domain event production and destination behavior stay in their packages.
- Import domain capabilities only from public `./observability` entrypoints. Never use private telemetry controllers.
- Keep every bridge fail-open, bounded, low-cardinality, secret-safe, independently tree-shakeable, and disposable.
- Add exhaustive event mapping, hostile-capability, rollback, packed-artifact, and size tests for behavior changes.
- Do not make domain packages depend on this package or add automatic global wiring.
