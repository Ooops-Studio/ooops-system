# @ooopsstudio/core

Foundation contracts and runtime utilities shared by Ooops System packages.

It deliberately contains interfaces and small infrastructure only: dependency
injection tokens, clocks, logging and observability contracts, optional service
ports, context utilities, batch/retry helpers, and safe utility functions.

It does not provide concrete errors, metrics, lifecycle, or tracing services.
Those remain optional ports that applications may register in their container.

## Install

```sh
pnpm add @ooopsstudio/core
```

## Use

```ts
import {createContainer} from '@ooopsstudio/core'
import {TOK} from '@ooopsstudio/core/tokens'

const container = createContainer()
container.bind(TOK.Clock, {now: () => Date.now()})
```

## Public boundaries

- `@ooopsstudio/core/contracts/*` exposes stable cross-package types.
- `@ooopsstudio/core/ports/*` exposes optional service interfaces.
- `@ooopsstudio/core/runtime/*` exposes minimal runtime helpers.
- `@ooopsstudio/core/utils/*` exposes dependency-free utilities.

Concrete domains belong in their dedicated packages.

## License

MIT. See the repository [LICENSE](../../LICENSE).
