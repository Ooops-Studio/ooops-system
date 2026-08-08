# @ooopsstudio/sdk

Framework-agnostic, tree-shakeable developer helpers built on the public contracts from `@ooopsstudio/core`.
The package intentionally has no root export: import only the integration subpath you use.

## Install

```bash
pnpm add @ooopsstudio/sdk @ooopsstudio/core
```

Optional integrations are installed only for their explicit subpaths:

```bash
pnpm add zod                         # @ooopsstudio/sdk/events/zod
pnpm add web-vitals                  # @ooopsstudio/sdk/performance-browser
pnpm add @grafana/faro-web-sdk       # @ooopsstudio/sdk/faro-browser
```

## Cache Namespaces And Keys

```ts
import {createCacheKeyBuilder, defineCacheNamespace} from '@ooopsstudio/sdk/cache'

type Article = {id: string; title: string}

export const articles = defineCacheNamespace<Article>('articles', {
	ttlMs: 60_000,
	staleTtlMs: 300_000
})

const articleKey = createCacheKeyBuilder('article')
export const key = articleKey({locale: 'en', slug: 'release-notes'})
```

Definitions and key inputs are validated, bounded and snapshotted before use.

## Events And AsyncAPI

The generic events entrypoint accepts any schema adapter with a `parse()` method and does not load Zod:

```ts
import {defineConsumer, defineEvent} from '@ooopsstudio/sdk/events'
import {generateAsyncApiDocument} from '@ooopsstudio/sdk/events/asyncapi'

const documentCreated = defineEvent({
	type: 'document.created',
	source: 'portfolio',
	schema: {
		parse(input: unknown) {
			if (!input || typeof input !== 'object') throw new TypeError('INVALID_DOCUMENT')
			return input as {id: string}
		},
		toJSONSchema: () => ({type: 'object', required: ['id']})
	}
})

const indexer = defineConsumer({name: 'search-index', eventTypes: [documentCreated.type]})
const contract = generateAsyncApiDocument({events: [documentCreated], consumers: [indexer]})
```

Use the isolated Zod adapter when a project uses Zod:

```ts
import {defineEvent} from '@ooopsstudio/sdk/events'
import {createZodEventSchema} from '@ooopsstudio/sdk/events/zod'
import {z} from 'zod'

const documentCreated = defineEvent({
	type: 'document.created',
	source: 'portfolio',
	schema: createZodEventSchema(z.object({id: z.string()}))
})
```

Event definitions, consumers and generated schema artifacts are immutable. Duplicate identities, unknown consumer events and oversized schemas fail deterministically.

## Job Schedules

```ts
import {cronSchedule, intervalSchedule} from '@ooopsstudio/sdk/jobs'

export const nightly = cronSchedule('nightly-index', '0 2 * * *', 'rebuild-index', {
	queue: 'maintenance',
	policy: {misfire: 'fire-once', overlap: 'skip'}
})

export const heartbeat = intervalSchedule('heartbeat', 30_000, 'check-health', {
	enabled: true
})
```

Schedule identity and timing fields are reserved. Untyped callers cannot replace `id`, `kind`, `task`, `cron` or `intervalMs` through the options object.

## Server And Database Instrumentation

```ts
import {instrumentFetchHandler} from '@ooopsstudio/sdk/performance'
import {measurePgQuery} from '@ooopsstudio/sdk/performance-db'

export const GET = instrumentFetchHandler(async() => new Response('ok'), {
	route: '/health'
})

const result = await measurePgQuery(
	() => pool.query('select * from projects where published = true'),
	{performance, text: 'select * from projects where published = true'}
)
```

Instrumentation is fail-open: the application operation remains authoritative when an optional observability port fails.

## Browser Observers

Install `web-vitals`, then start the selected observers and retain the returned cleanup function:

```ts
import {startBrowserObservers} from '@ooopsstudio/sdk/performance-browser'

const stopObservers = startBrowserObservers({
	preset: 'production',
	performance,
	route: () => window.location.pathname,
	webVitals: true,
	longTasks: true,
	resourceFailures: true
})

window.addEventListener('pagehide', stopObservers, {once: true})
```

## Faro Browser Runtime

```ts
import {initFaroBrowser, startFaroBrowserObservers} from '@ooopsstudio/sdk/faro-browser'

const faro = initFaroBrowser({
	config: {
		url: 'https://faro.example.com/collect',
		app: {name: 'portfolio', version: '1.0.0', environment: 'production'}
	}
})

const stopObservers = startFaroBrowserObservers({
	client: faro,
	preset: 'production',
	route: () => window.location.pathname
})

window.addEventListener('pagehide', stopObservers, {once: true})
```

`initFaroBrowser()` is idempotent for the same normalized configuration. Observer subscriptions and aggregation timers are owned by the returned cleanup function.

## Public Subpaths

- `@ooopsstudio/sdk/cache`
- `@ooopsstudio/sdk/events`
- `@ooopsstudio/sdk/events/zod`
- `@ooopsstudio/sdk/events/asyncapi`
- `@ooopsstudio/sdk/jobs`
- `@ooopsstudio/sdk/performance`
- `@ooopsstudio/sdk/performance-browser`
- `@ooopsstudio/sdk/performance-db`
- `@ooopsstudio/sdk/faro-browser`

## Runtime Policy

- ESM-only and Node `>=22.14.0` for server-side helpers.
- `performance-browser` and `faro-browser` are browser-only entrypoints.
- Optional integrations are isolated and never loaded by unrelated subpaths.
- Public API is limited to the documented export map; deep internal imports are unsupported.
- Versioning and breaking changes are managed through Changesets.

## License

MIT © 2026 Ooops Design Studio
