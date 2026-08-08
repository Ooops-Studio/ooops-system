# @ooopsstudio/lifecycle

Staged startup, cached health, readiness/liveness probes, graceful draining, flushes, and retryable shutdown for long-running applications.

The package depends only on `@ooopsstudio/core`. Logging, errors, metrics, and tracing are optional core ports and cannot change lifecycle behavior when they fail.

## Public entrypoints

- `@ooopsstudio/lifecycle`: DI registration and lifecycle error types.
- `@ooopsstudio/lifecycle/development`: development preset factory.
- `@ooopsstudio/lifecycle/production`: production preset factory.
- `@ooopsstudio/lifecycle/custom`: fully configurable runtime factory.
- `@ooopsstudio/lifecycle/node`: explicit Node process-listener adapter.
- `@ooopsstudio/lifecycle/observability`: bounded optional-port attachment.
- `@ooopsstudio/lifecycle/public/types`: managed public types only.

Legacy service imports must migrate to these package entrypoints. Concrete logging, errors,
metrics, tracing, signal handling, and host termination remain outside the root runtime.

## Install

```sh
pnpm add @ooopsstudio/lifecycle @ooopsstudio/core
```

## Runtime

```ts
import {createProductionLifecycle} from '@ooopsstudio/lifecycle/production'

const lifecycle = createProductionLifecycle({
	resource: {serviceName: 'api'}
})

lifecycle.registerStartupHook('init', async({signal}) => {
	await initializeDatabase(signal)
})

lifecycle.registerHealthCheck({
	name: 'database',
	criticality: 'required',
	check: async({signal}) => await pingDatabase(signal)
		? {healthy: true}
		: {healthy: false, code: 'DATABASE_UNAVAILABLE'}
})

await lifecycle.start()
```

The runtime follows `idle -> starting -> running -> draining -> closed`. `beginDrain()` closes readiness and registration admission without running shutdown hooks. `shutdown()` is single-flight and retryable after bounded failure or timeout. `flush()` does not begin a drain.

## Container registration

```ts
import {createContainer} from '@ooopsstudio/core'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {TOK} from '@ooopsstudio/core/tokens'
import {registerLifecycle} from '@ooopsstudio/lifecycle'

const container = createContainer()
container.bind(TOK.Clock, createSystemClock())
await registerLifecycle(container, {preset: 'production'})
```

Registration uses any errors, logging, metrics, or tracing ports already bound to the container. Those integrations remain optional and are isolated from lifecycle state transitions.

## Node process ownership

Factories never install process-global listeners. A Node host opts in explicitly:

```ts
import {attachNodeLifecycle} from '@ooopsstudio/lifecycle/node'

const detach = attachNodeLifecycle(lifecycle, {
	fatalErrors: {
		onFatalError(error, type) {
			console.error(type, error.message)
		},
		terminate(exitCode) {
			process.exitCode = exitCode
		}
	}
})
```

The adapter handles `SIGTERM` and `SIGINT` by default. Fatal handlers are installed only when configured, termination remains host-owned, and the package never calls `process.exit()`.

## Observability

Ports can be supplied at factory creation or attached later through `@ooopsstudio/lifecycle/observability`. Attachment only fills missing ports, rejects conflicts atomically, and returns an idempotent disposer.

```ts
import {attachLifecycleObservability} from '@ooopsstudio/lifecycle/observability'

const detach = attachLifecycleObservability(lifecycle, {logger, metrics})
```

## License

MIT. See the repository [LICENSE](../../LICENSE).
