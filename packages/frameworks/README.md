# @ooopsstudio/frameworks

Framework adapters for **@ooopsstudio/core** and **@ooopsstudio/sdk**, providing idiomatic bindings for Svelte and React.  
Designed to expose the same deterministic logic through reactive, component-based APIs.

---

## Installation

```bash
pnpm add @ooopsstudio/frameworks
# or
npm install @ooopsstudio/frameworks
```

---

## Usage (Svelte)

```svelte
<script lang="ts">
  import { useForm } from '@ooopsstudio/frameworks/svelte/forms'
  import { useLogger } from '@ooopsstudio/frameworks/svelte/logging'

  const form = useForm({ schema })
  const log = useLogger()
</script>
```

## Usage (React)

```tsx
import { useLogger } from '@ooopsstudio/frameworks/react'
import { useForm } from '@ooopsstudio/frameworks/react/forms'

const Component = () => {
  const logger = useLogger()
  const form = useForm({ schema })

  return <form onSubmit={form.handleSubmit}>...</form>
}
```

---

## Structure

| Framework | Features |
|------------|-----------|
| **Svelte** | actions, stores, components, and features |
| **React** | hooks and bindings for core + sdk utilities |

---

## Requirements

- Node 22.x or later  
- TypeScript strict mode  
- Svelte 5 or React 18+

---

## License

[MIT](./LICENSE) © Ooops Studio