# Ooops System — Monorepo

A modular, framework-agnostic infrastructure suite for building production-grade web applications.  
Unifies runtime logic, SDK utilities, and framework integrations under a single, deterministic monorepo.

---

## Overview

The **Ooops System** is structured for clarity, composability, and reproducible builds.  
It provides three main public packages and supporting developer tooling.

### Packages

| Package | Description |
|----------|--------------|
| [`@ooopsstudio/core`](./packages/core) | Deterministic runtime, ports, engines, and services |
| [`@ooopsstudio/sdk`](./packages/sdk) | Developer utilities and platform integrations |
| [`@ooopsstudio/frameworks`](./packages/frameworks) | Framework adapters for Svelte and React |

---

## Installation

```bash
pnpm install
pnpm -r build
```

---

## Development Standards

- Node 22+  
- TypeScript strict mode  
- pnpm 9+  
- Vitest + V8 coverage  
- ESLint Stylistic  
- Deterministic builds with tsup  

---

## CI and Publishing

The repository includes reusable workflows for CI, validation, and releases via **Changesets**.  
Each package is published under the `@ooopsstudio` scope on npm.

---

## License

[MIT](./LICENSE) © Ooops Studio
