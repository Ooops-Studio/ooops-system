# @ooopsstudio/core

Deterministic, framework-agnostic runtime for building production-grade web systems.  
Includes typed ports, pure engines, and modular services for logging, cache, resilience, and observability — all composable, side-effect-free, and designed for Node 22+.

---

## Installation

```bash
pnpm add @ooopsstudio/core
# or
npm install @ooopsstudio/core
```

---

## Usage

```ts
import { createLogger } from '@ooopsstudio/core/logging'
import { createResiliencePolicy } from '@ooopsstudio/core/resilience'

const logger = createLogger({ level: 'info' })
const policy = createResiliencePolicy({ retries: 3 })

logger.info('System initialized')
```

Each module is tree-shakeable and adheres to strict import fences enforced by CI.  
For example:
- **L0 Root** → contracts, tokens, ports  
- **L1 Engines** → deterministic, DI-free factories  
- **L2 Edges** → safe defaults and bridges  
- **L3 Services** → runtime features (logging, cache, metrics, etc.)

---

## Architecture Overview

`@ooopsstudio/core` is part of the **Ooops System** monorepo — a modular infrastructure suite for reproducible web applications.

| Layer | Package | Purpose |
|-------|----------|----------|
| Core | `@ooopsstudio/core` | Runtime logic and services |
| SDK | `@ooopsstudio/sdk` | Developer utilities |
| Frameworks | `@ooopsstudio/frameworks` | Framework adapters (Svelte, React) |

---

## Requirements

- **Node:** 22.x or later  
- **TypeScript:** Strict mode  
- **Package Manager:** pnpm ≥ 9  

---

## License

[MIT](./LICENSE) © Ooops Studio
