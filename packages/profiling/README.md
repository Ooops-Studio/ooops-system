# @ooopsstudio/profiling

Bounded CPU profiling for Ooops System applications. The managed runtime returns frozen, metadata-only capture summaries; raw `.cpuprofile` artifacts are available only through explicit privileged profiler and exporter contracts.

## Install

```bash
pnpm add @ooopsstudio/profiling @ooopsstudio/core
```

Install `@pyroscope/nodejs` only when using the explicit Pyroscope provider:

```bash
pnpm add @pyroscope/nodejs
```

## Managed profiling

Development lazily enables manual Node Inspector captures. Production is continuous-provider-only. Custom configuration accepts an explicit manual profiler, continuous provider, and at most two artifact destinations.

```ts
import {createDevelopmentProfiling} from '@ooopsstudio/profiling/development'

const profiling = await createDevelopmentProfiling({
  resource: {
    serviceName: 'checkout-worker',
    deploymentEnvironment: 'development'
  }
})

const summary = await profiling.capture({durationMs: 1_000})
console.log(summary)

await profiling.flush()
await profiling.shutdown()
```

The managed API is intentionally limited to `capture()`, `getStatus()`, `flush()`, and retryable `shutdown()`. It does not expose queues, mutable manager state, raw profile data, heap profiles, telemetry events, or automatic incident capture.

## Container registration

The root entrypoint registers a selected preset without eagerly importing Inspector or Pyroscope implementations.

```ts
import {registerProfiling} from '@ooopsstudio/profiling'
import {TOK} from '@ooopsstudio/core/tokens'

await registerProfiling(container, {preset: 'development'})

const profiling = container.get(TOK.Profiling)
```

Logging, errors, metrics, tracing, and lifecycle integrations are optional core ports. Their failures do not change capture, delivery, or shutdown behavior.

## Explicit entrypoints

- `@ooopsstudio/profiling/development`
- `@ooopsstudio/profiling/production`
- `@ooopsstudio/profiling/custom`
- `@ooopsstudio/profiling/profilers/inspector`
- `@ooopsstudio/profiling/providers/pyroscope`
- `@ooopsstudio/profiling/exporters/console`
- `@ooopsstudio/profiling/exporters/memory`
- `@ooopsstudio/profiling/observability`

Inspector, Pyroscope, and the raw artifact exporters are privileged opt-in boundaries. Browser-safe and root imports do not load their Node implementations.

## Pyroscope

```ts
import {createPyroscopeProfiling} from '@ooopsstudio/profiling/providers/pyroscope'

const continuous = createPyroscopeProfiling({
  applicationName: 'checkout-worker',
  connection: {
    mode: 'grafana-cloud',
    serverAddress: 'https://profiles.example.com/ingest',
    credentials: {
      username: process.env.PYROSCOPE_USERNAME!,
      password: process.env.PYROSCOPE_PASSWORD!
    }
  },
  resource: {
    serviceName: 'checkout-worker',
    deploymentEnvironment: 'production'
  }
})
```

Grafana Cloud and every credential-bearing endpoint require HTTPS. URLs with embedded credentials, query strings, or fragments are rejected. HTTP is accepted only for credential-free Alloy or self-hosted modes, and TLS verification is never weakened.

SDK-level `PYROSCOPE_*` environment overrides that could redirect traffic, inject credentials, or bypass bounded sampling are rejected before initialization. The optional peer is dynamically imported only by the provider entrypoint.

## Observability attachment

The observability entrypoint exposes frozen raw domain events without mapping them to a concrete logging, errors, or metrics implementation. Use `@ooopsstudio/bridges/profiling` for the standard cross-domain mapping.

```ts
import {attachProfilingObservability} from '@ooopsstudio/profiling/observability'

const detach = attachProfilingObservability(profiling, (event) => {
  // Route the bounded event to a project-specific destination.
  console.info(event.kind)
})

detach()
```

One continuous provider and one manual CPU capture may own a Node process at a time. Timed-out physical work retains ownership until it settles, and repeated shutdown continues unresolved cleanup without starting duplicate finalizers.

## License

MIT
