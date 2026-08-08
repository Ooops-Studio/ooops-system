# @ooopsstudio/logging

Structured logging for Ooops System applications.

The package provides development, production, and custom presets; formatting,
redaction, sinks, batching, retry, backpressure, and optional observability
integration. Its only runtime dependency is `@ooopsstudio/core`.

## Install

```sh
pnpm add @ooopsstudio/logging @ooopsstudio/core
```

## Use a preset

```ts
import {createDevelopmentLogging} from '@ooopsstudio/logging/development'

const logging = await createDevelopmentLogging()
await logging.info('Application started')
```

## Register in a container

```ts
import {createContainer} from '@ooopsstudio/core'
import {TOK} from '@ooopsstudio/core/tokens'
import {registerLogging} from '@ooopsstudio/logging'

const container = createContainer()
container.bind(TOK.Clock, {now: () => Date.now()})

await registerLogging(container, {preset: 'production'})
```

Errors, metrics, lifecycle, and tracing are optional `@ooopsstudio/core` ports.
When present in the container, logging uses them without depending on concrete
implementations.

## Entrypoints

- `@ooopsstudio/logging` registration API
- `@ooopsstudio/logging/development`
- `@ooopsstudio/logging/production`
- `@ooopsstudio/logging/custom`
- `@ooopsstudio/logging/sinks`

## License

MIT. See the repository [LICENSE](../../LICENSE).
