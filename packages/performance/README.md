# @ooopsstudio/performance

Bounded server performance measurements, budgets, runtime monitoring, N+1 detection, and optional event delivery for Ooops System applications.

## Install

```bash
pnpm add @ooopsstudio/performance @ooopsstudio/core
```

## Presets

```ts
import {createProductionPerformance} from '@ooopsstudio/performance/production'

const performance = await createProductionPerformance()
await performance.measureAsync('checkout', async () => processCheckout())
await performance.flush()
await performance.shutdown()
```

Development and production enable bounded event-loop, GC, and resource monitors. Custom composition can add immutable budgets, trace-scoped N+1 detection, selected runtime monitors, and at most two event destinations.

## Container registration

```ts
import {registerPerformance} from '@ooopsstudio/performance'

await registerPerformance(container, {preset: 'production'})
```

Errors, tracing, and lifecycle are optional core ports. Their failure does not change measurement, delivery, or shutdown behavior.

## Explicit entrypoints

- `@ooopsstudio/performance/development`
- `@ooopsstudio/performance/production`
- `@ooopsstudio/performance/custom`
- `@ooopsstudio/performance/custom/exporters/raw`
- `@ooopsstudio/performance/custom/exporters/http`
- `@ooopsstudio/performance/observability`
- `@ooopsstudio/performance/public/types`

The observability entrypoint emits bounded domain events. Cross-domain mapping to logging, errors, metrics, and tracing belongs in an integration or bridges package.

Browser RUM and Web Vitals are intentionally outside this server package.

## License

MIT
