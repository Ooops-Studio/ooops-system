# `@ooopsstudio/sveltekit`

Svelte 5 / SvelteKit 2 adapters for server instrumentation and DOM actions. The package does not create services, own lifecycle, or re-export the SDK.

## Install

```bash
pnpm add @ooopsstudio/sveltekit @ooopsstudio/sdk @ooopsstudio/core @sveltejs/kit svelte
```

## Server composition

Configure the top-level request wrapper in `hooks.server.ts`:

```ts
import {instrumentHandle, instrumentHandleError} from '@ooopsstudio/sveltekit/server'

export const handle = instrumentHandle(async({event, resolve}) => await resolve(event), {
  performance,
  tracing
})

export const handleError = instrumentHandleError(undefined, {
  errors,
  logger,
  tracing
})
```

`instrumentHandle()` owns request performance and span state only. It records HTTP method/status attributes, exceptions, and error span status, but deliberately does not log or report errors. `instrumentHandleError()` is the single Errors/logger owner.

Do not install `instrumentHandleError()` when another application hook already reports and logs the same SvelteKit error. A custom handler may be wrapped when its return value must be preserved:

```ts
export const handleError = instrumentHandleError(
  ({message}) => ({message}),
  {errors, logger}
)
```

The remaining server wrappers are narrow and composable:

```ts
import {
  instrumentAction,
  instrumentHandleFetch,
  instrumentLoad,
  instrumentRequestHandler
} from '@ooopsstudio/sveltekit/server'

export const GET = instrumentRequestHandler(async() => new Response('ok'), {
  performance,
  tracing
})

export const load = instrumentLoad(async({url}) => ({pathname: url.pathname}), {
  performance,
  tracing
})

export const actions = {
  save: instrumentAction(async() => ({saved: true}), {performance, tracing})
}

export const handleFetch = instrumentHandleFetch(
  async({request, fetch}) => await fetch(request),
  {performance, tracing}
)
```

`instrumentHandleFetch()` creates a client span but does not inject trace headers. Applications that need distributed propagation must inject through their tracing runtime before invoking `fetch`; this adapter never mutates outbound requests implicitly.

Optional observability ports are fail-open and application callbacks execute exactly once,
even if a tracing implementation duplicates, suppresses, rejects, or hangs its callback.
Adapter options are snapshotted without invoking accessors, and custom labels cannot
replace canonical route, runtime, kind, or action dimensions.

## Actions

```svelte
<script lang="ts">
  import {measureClick, measureSubmit, measureVisible} from '@ooopsstudio/sveltekit/actions'

  const click = {name: 'portfolio.cta.click', performance}
  const submit = {name: 'contact.submit', performance, once: true}
  const visible = {name: 'project.visible', performance, once: true}
</script>

<a href="/contact" use:measureClick={click}>Contact</a>
<form use:measureSubmit={submit}>...</form>
<section use:measureVisible={visible}>...</section>
```

Svelte calls each action's `update()` when options change and `destroy()` when the element is removed. The action cleans up event listeners or its `IntersectionObserver` in both paths.

When `IntersectionObserver` is unavailable, `measureVisible` is a no-op because inability to observe is not proof of visibility. Explicitly opt into the old fallback only when that approximation is acceptable:

```ts
const visible = {
  name: 'project.visible',
  performance,
  fallback: 'record' as const
}
```

## Boundaries

- Server adapters never own or create observability services.
- `instrumentHandleError` is the only Errors/logger projection in this package.
- Browser actions do not import SvelteKit server code.
- Browser observers, Faro and database adapters remain in their dedicated `@ooopsstudio/sdk/*` subpaths.
- The package intentionally has no root export.

## License

MIT © 2026 Ooops Design Studio
