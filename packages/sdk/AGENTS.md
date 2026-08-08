# SDK Package Guidance

## Scope

This package owns framework-agnostic developer helpers built on public core contracts. Keep each public subpath independently consumable and preserve the server/browser boundary.

## Required workflow

- Run tests, typecheck, browser bundle checks, build, size, publint, attw, and packed-artifact checks for public API changes.
- Add adversarial tests for wrappers, callbacks, payloads, labels, and browser observers.

## Boundaries

- Depend only on `@ooopsstudio/core`; do not import concrete domain packages or bridges.
- Keep Zod isolated to `events/zod`, Web Vitals to `performance-browser`, and Faro to `faro-browser`.
- Keep browser-only types and behavior in the SDK rather than the server-oriented core.

## Avoid

- Do not add a catch-all root export or make unrelated integrations load together.
- Do not leak dynamic routes, queries, credentials, payloads, or raw errors into labels.
- Do not introduce Node built-ins into browser entrypoints.
