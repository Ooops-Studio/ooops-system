# SvelteKit Package Guidance

## Scope

This package adapts public core and SDK capabilities to Svelte 5 and SvelteKit 2. It owns wrappers and DOM actions, not observability runtimes or UI components.

## Required workflow

- Run tests, typecheck, browser bundle checks, build, size, publint, attw, and packed-artifact checks for adapter changes.
- Test exactly-once application callbacks, fail-open observability, route normalization, and action cleanup.

## Boundaries

- Depend only on `@ooopsstudio/core` and `@ooopsstudio/sdk` plus Svelte peer APIs.
- Keep `./server` free of browser-only integrations and `./actions` free of SvelteKit server code.
- Share generic behavior through the SDK; do not duplicate its instrumentation helpers.

## Avoid

- Do not create services, own lifecycle, or import concrete domain packages or bridges.
- Do not reintroduce removed bootstrap, state, client, resilience, or catch-all root APIs.
- Do not swallow or repeat application callbacks while reporting observability failures.
