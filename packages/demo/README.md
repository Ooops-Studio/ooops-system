# @your-scope/demo

Tiny example library used by the monorepo template to demonstrate build, test, lint, and publish flow.

## Install

```sh
pnpm add @your-scope/demo
```

## Usage

```ts
import {greet} from '@your-scope/demo'

console.log(greet('World')) // "Hello, World"
```

## API

### `greet(name: string): string`

Returns a friendly greeting. Pure, no side effects.

**Example:**
```ts
greet('Alice') // "Hello, Alice"
```

## Development

- Build: `pnpm -w -F @your-scope/demo build`
- Test: `pnpm -w -F @your-scope/demo test`
- Lint: `pnpm -w -F @your-scope/demo lint`
- Typecheck: `pnpm -w -F @your-scope/demo typecheck`
- Size: `pnpm -w -F @your-scope/demo size`

## Project structure

```
packages/demo/
├─ src/
│  └─ index.ts
├─ test/
│  └─ index.test.ts
├─ package.json
├─ tsconfig.json
├─ tsup.config.ts
└─ size-limit.json
```

## Publishing

This package is versioned and published via Changesets from the monorepo root:

```sh
pnpm -w changeset
pnpm -w changeset version
pnpm install
pnpm -w -r build
pnpm -w changeset publish
```

## License

MIT (change as needed).