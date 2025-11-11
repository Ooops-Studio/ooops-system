# @ooopsstudio/sdk

High-level developer utilities and integrations built on top of **@ooopsstudio/core**.  
Includes framework-agnostic helpers for analytics, forms, configuration, cookies, and more — all deterministic, composable, and type-safe.

---

## Installation

```bash
pnpm add @ooopsstudio/sdk
# or
npm install @ooopsstudio/sdk
```

---

## Usage

```ts
import { useAnalytics } from '@ooopsstudio/sdk/analytics'
import { loadConfig } from '@ooopsstudio/sdk/config'

const analytics = useAnalytics({ provider: 'plausible' })
const config = loadConfig({ schema })

analytics.track('page_view')
```

---

## Features

- **Analytics** – unified provider-agnostic API (Plausible, Matomo, etc.)  
- **Forms** – validation, state, and serialization with no framework lock-in  
- **Config** – typed configuration loading and schema validation  
- **Cookies** – consent and secure cookie handling  
- **Utils** – lightweight helpers for i18n, URLs, and formatting  

---

## Relation to Core

`@ooopsstudio/sdk` builds on top of [`@ooopsstudio/core`](https://www.npmjs.com/package/@ooopsstudio/core), extending its deterministic runtime into developer-facing tools.

---

## Requirements

- Node 22.x or later  
- TypeScript strict mode  

---

## License

[MIT](./LICENSE) © Ooops Studio