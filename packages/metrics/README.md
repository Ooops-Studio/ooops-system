# @ooopsstudio/metrics

Bounded metrics recording, aggregation, and delivery for Ooops System applications.

The package provides development, production, Prometheus, OTLP, and custom presets. Its only runtime dependency is `@ooopsstudio/core`; logging, errors, lifecycle, and tracing integrations are optional core ports.

## Install

```sh
pnpm add @ooopsstudio/metrics @ooopsstudio/core
```

## Development

```ts
import {createDevelopmentMetrics} from '@ooopsstudio/metrics/development'

const metrics = await createDevelopmentMetrics()
metrics.counter('requests_total', 1, {route: '/health'})
await metrics.flush()
await metrics.shutdown()
```

## Prometheus

```ts
import {createPrometheusMetrics} from '@ooopsstudio/metrics/production/prometheus'
import {createPrometheusHttpServer} from '@ooopsstudio/metrics/sinks/prometheus-http'

const metrics = await createPrometheusMetrics()
const server = createPrometheusHttpServer(metrics)
await server.start()
```

The HTTP adapter is explicit and binds to loopback by default. Production OTLP endpoints require public HTTPS and reject credentials, query strings, fragments, redirects, and private network targets.

## License

MIT. See the repository [LICENSE](../../LICENSE).
