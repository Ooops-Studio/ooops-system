# `@ooopsstudio/resilience`

Bounded timeout, retry, circuit-breaker, bulkhead, and request-coalescing resilience for Node.js 20+.

## Install

```bash
pnpm add @ooopsstudio/core @ooopsstudio/resilience
```

## Entry points

- `@ooopsstudio/resilience`: DI registration and public contracts.
- `@ooopsstudio/resilience/development`: development preset.
- `@ooopsstudio/resilience/production`: production preset.
- `@ooopsstudio/resilience/custom`: explicit classifiers and fallback composition.
- `@ooopsstudio/resilience/observability`: narrow fail-open event attachment.
- `@ooopsstudio/resilience/public/types`: managed API, contracts, and option types.

## Usage

```ts
import {createProductionResilience} from '@ooopsstudio/resilience/production'

const resilience = createProductionResilience({
	policies: [{
		name: 'upstream.read',
		operationKind: 'external.http',
		timeout: {defaultMs: 2_000},
		retry: false,
		circuitBreaker: false,
		bulkhead: false,
		coalescing: false
	}]
})

const result = await resilience.execute({
	operation: 'catalog.fetch',
	policy: 'upstream.read',
	context: {resource: 'catalog'}
}, async (signal) => fetchCatalog({signal}))

await resilience.shutdown()
```

Policies are immutable bootstrap configuration. Optional logging, errors, metrics, tracing, performance, and lifecycle integrations are accepted only through `@ooopsstudio/core` ports and remain fail-open.

## Observability

```ts
import {attachResilienceObservability} from '@ooopsstudio/resilience/observability'

const detach = attachResilienceObservability(resilience, (event) => {
	// Map bounded events to application telemetry in a bridge layer.
})
```

Caching, rate limiting, and distributed idempotency are separate capabilities and are intentionally not composed into this package.

## License

MIT
