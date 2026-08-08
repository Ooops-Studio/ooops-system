# `@ooopsstudio/bridges`

Explicit, bounded cross-domain adapters for Ooops System packages. Domain packages emit raw observability events; this package maps those events to the optional logging, errors, metrics, and tracing ports.

```ts
import {wireObservability} from '@ooopsstudio/bridges'

const dispose = await wireObservability(container)
// Dispose in application shutdown after the domain runtimes have drained.
dispose()
```

Each domain bridge is independently importable, for example:

```ts
import {wireCacheObservability} from '@ooopsstudio/bridges/cache'

const dispose = wireCacheObservability(cache, {logger, errors, metrics, tracer})
```

All destination ports are optional. Bridge failures are isolated from domain behavior, labels are bounded and low-cardinality, and aggregate wiring rolls back earlier attachments if a later attachment fails.

The package never installs lifecycle hooks, changes service health, or imports private runtime/telemetry paths.

## License

MIT. See the repository license.
