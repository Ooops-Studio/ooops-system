# `@ooopsstudio/cache`

Bounded cache-aside runtime for Node.js 20+. It provides an in-memory development preset, a Redis production preset, and a custom-backend preset without coupling applications to a Redis client library.

## Install

```bash
pnpm add @ooopsstudio/core @ooopsstudio/cache
```

## Entry points

- `@ooopsstudio/cache`: DI registration and public types.
- `@ooopsstudio/cache/development`: bounded in-memory runtime.
- `@ooopsstudio/cache/production`: Redis-backed production runtime.
- `@ooopsstudio/cache/custom`: caller-owned backend runtime.
- `@ooopsstudio/cache/observability`: narrow, fail-open event attachment.
- `@ooopsstudio/cache/public/types`: public contracts and option types.

## Development

```ts
import {createDevelopmentCache} from '@ooopsstudio/cache/development'

const cache = createDevelopmentCache({namespace: 'portfolio'})
await cache.set('project:1', {title: 'Example'}, {ttlMs: 60_000})
const project = await cache.get<{title: string}>('project:1')
await cache.shutdown()
```

## Production

The production preset accepts a structural Redis port. The selected client must provide the compatible `eval` capability; this package does not impose a Redis SDK.

```ts
import {createProductionCache} from '@ooopsstudio/cache/production'

const cache = createProductionCache({
	namespace: 'portfolio',
	redis: redisAdapter
})
```

Production never falls back to memory. Redis scripts preserve atomic mutation and invalidation behavior.

## Custom backend

```ts
import {createCustomCache} from '@ooopsstudio/cache/custom'

const cache = createCustomCache({backend, defaultNamespace: 'portfolio'})
```

Custom backends implement `CacheBackendPort` from `@ooopsstudio/core/ports/cache`.

## Observability

```ts
import {attachCacheObservability} from '@ooopsstudio/cache/observability'

const detach = attachCacheObservability(cache, (event) => {
	// Map the bounded event to application telemetry in a bridge layer.
})
```

Only one observer may be active. Listener failures are isolated from cache operations, and the returned disposer is idempotent.

## Runtime guarantees

- Bounded entries, bytes, keys, batches, in-flight operations, and loader work.
- Immutable metadata and status snapshots.
- Single-flight cache-aside loading with stale and negative-cache policies.
- Bounded, retryable `flush()` and `shutdown()` behavior.
- Hostile getters, proxies, oversized values, and post-admission mutation are rejected or contained.
- Lifecycle integration is optional through the core port.

## License

MIT
