# `@ooopsstudio/rate-limit`

Bounded fixed-window and token-bucket rate limiting for Node.js 20+. It provides memory-backed development, atomic Redis production, custom composition, and framework-neutral HTTP projections.

## Install

```bash
pnpm add @ooopsstudio/core @ooopsstudio/rate-limit
```

## Entry points

- `@ooopsstudio/rate-limit`: DI registration and public types.
- `@ooopsstudio/rate-limit/development`: in-memory runtime.
- `@ooopsstudio/rate-limit/production`: Redis-backed runtime.
- `@ooopsstudio/rate-limit/custom`: explicit memory or Redis composition.
- `@ooopsstudio/rate-limit/http`: rate-limit response headers and 429 metadata.
- `@ooopsstudio/rate-limit/observability`: narrow fail-open event attachment.
- `@ooopsstudio/rate-limit/public/types`: contracts and option types.

## Development

```ts
import {createDevelopmentRateLimit} from '@ooopsstudio/rate-limit/development'

const rateLimit = createDevelopmentRateLimit({
	policies: [{name: 'api.user', partition: 'keyed', limit: 100, windowMs: 60_000}]
})

const decision = await rateLimit.check({policy: 'api.user', key: userId})
await rateLimit.shutdown()
```

## Production

Production accepts a structural Redis port with an atomic `eval()` method. No Redis SDK is required by this package and production never falls back to memory.

```ts
import {createProductionRateLimit} from '@ooopsstudio/rate-limit/production'

const rateLimit = createProductionRateLimit({
	redis: redisAdapter,
	namespace: 'portfolio',
	onBackendError: 'block',
	policies: [{name: 'api.user', partition: 'keyed', limit: 100, windowMs: 60_000}]
})
```

## HTTP and observability

```ts
import {decisionToHeaders} from '@ooopsstudio/rate-limit/http'
import {attachRateLimitObservability} from '@ooopsstudio/rate-limit/observability'

const detach = attachRateLimitObservability(rateLimit, (event) => {
	// Map bounded events to application telemetry in a bridge layer.
})
```

`checkMany()` is ordered and fail-fast. Earlier successful consumes are not rolled back. `RateLimit-Reset` is emitted as delay-seconds relative to the provided clock value.

## License

MIT
