# Package Archetype Examples

These examples are intentionally **not** part of the workspace. They exist to document how the template can expand without forcing one package shape on every repo.

Each archetype demonstrates a supported package contract:

- `public-package/` — publishable single-entry library
- `private-workspace/` — internal package that only participates in required root checks
- `multi-entry-package/` — publishable package with multiple public subpath exports
- `adapter-package/` — publishable package with peer dependencies and package-local overrides

All archetypes keep package complexity local:

- root orchestrates package scripts
- package decides its own `exports`
- package decides whether it needs `vitest`, `tsup`, or `size-limit` overrides
- package can remain private by omitting publish-oriented scripts

Use `pnpm -w smoke:archetypes` to verify these examples still match the documented workspace contract.
