# Monorepo Template

Opinionated TypeScript + pnpm workspace monorepo template. It ships with Vitest (V8 coverage), ESLint (flat config), tsup builds, Husky + Commitlint, Changesets, dependency-cruiser, publint, are-the-types-wrong, and size-limit. Batteries included; vendor lock-in not included.

## Requirements

- Node 20.x or 22.x
- pnpm 9.x

## Quick start

1. Use this repository as a **Template** on GitHub.
2. Clone your new repository and install:
   - `pnpm install`
3. Validate everything:
   - `pnpm -w validate`  
     (runs typecheck, lint, build, tests, size-limit, dep-cruise, publint, attw)

## What’s inside

- **TypeScript**: strict, ESM, project references ready
- **Vitest**: node environment, V8 coverage, per-package opt-in config
- **ESLint (flat)**: tabs, single quotes, no semicolons, max line length 100
- **tsup**: ESM output, d.ts, sourcemaps, tree-shakeable
- **Husky + Commitlint**: Git hooks, Conventional Commits
- **Changesets**: versioning and publishing flow
- **dependency-cruiser**: no cycles, no unresolved, no importing other packages’ internals
- **publint & are-the-types-wrong**: package publishing sanity checks
- **size-limit**: per-entry bundle budgets

## Workspace layout

```
.
├─ packages/
│  └─ demo/                 # example package (you can delete or replace)
├─ .github/workflows/ci.yml # CI pipeline (calls pnpm -w validate)
├─ .github/workflows/release.yml # Auto-release (Changesets)
├─ tsconfig.base.json       # shared TS config
├─ eslint.config.js         # flat ESLint config
├─ .dependency-cruiser.cjs  # graph rules (no cycles, no cross-internals)
├─ package.json             # workspace scripts
├─ README.md                # README file
└─ vitest.config.ts         # vitest config
```

## Common scripts (root)

- `pnpm -w typecheck` — TypeScript type check for the workspace  
- `pnpm -w lint` — ESLint across the workspace  
- `pnpm -w build` — build all packages with tsup  
- `pnpm -w test` — run Vitest across packages  
- `pnpm -w size` — run size-limit across packages  
- `pnpm -w depcruise` — dependency-cruiser checks  
- `pnpm -w publint` — publint checks on built packages  
- `pnpm -w attw` — are-the-types-wrong checks  
- `pnpm -w validate` — runs the full validation pipeline above

Filter by package: `pnpm -w -F @your-scope/<pkg> <script>`

---

## Auto-release (Changesets + GitHub Actions)

Two supported ways to authenticate with npm:

### Option A: Classic npm token (fastest)

1) Create npm token  
- On npmjs.com → Access Tokens → Generate new token (automation).  
- Copy the token.

2) Add repo secret  
- GitHub → your repo → Settings → Secrets and variables → Actions → **New repository secret**  
- Name: `NPM_TOKEN`  
- Value: your npm token

3) Ensure packages are publishable  
Inside each `packages/<name>/package.json`:
- `"name": "@your-scope/<name>"` (or unscoped if you prefer)  
- `"version": "0.0.0"` (or whatever you start with)  
- `"publishConfig": { "access": "public" }` for scoped public packages  
- `"files": ["dist"]` and your build emits to `dist/`  
- `repository`, `author`, `license` filled in

4) Release workflow  
This template includes `.github/workflows/release.yml` that:
- installs Node + pnpm
- runs `pnpm -w validate`
- runs `changesets/action@v1` to open a **Version Packages** PR and to publish after it’s merged

If GitHub blocks PR creation by Actions in your org, add a **Personal Access Token (classic)** with `repo` scope as a secret named `RELEASE_TOKEN` and set the action to use it:
- In `release.yml`, set `GITHUB_TOKEN: ${{ secrets.RELEASE_TOKEN }}` for the Changesets step.

### Option B: npm Trusted Publishing (OIDC; no long-lived token)

1) Link repo to npm
- On npmjs.com → your org or package → **Trusted publishers** → Add GitHub repository/workflow as a trusted publisher (follow the UI steps).

2) Enable provenance  
- In `release.yml`, ensure:
  - `permissions: id-token: write`
  - `NPM_CONFIG_PROVENANCE: true` env
- Remove `NPM_TOKEN` usage.

3) First publish  
If the package doesn’t exist on npm yet, you can still publish via trusted publishing once configured. If the UI blocks linking until the package exists, do a one-time manual publish locally with `npm publish --access public`, then switch to trusted publishing.

---

## Release flow (TL;DR)

1) Create a feature branch  
2) Do your changes  
3) Create a changeset: `pnpm -w changeset`  
   - choose affected packages and bump type (patch/minor/major)  
4) Commit and push your branch  
5) Open PR → merge PR  
6) The release workflow will open a **Version Packages** PR (bumps versions, writes changelogs)  
7) Merge the **Version Packages** PR into `main`  
8) The release workflow publishes to npm

> No changeset = no version bump = no publish.

### Manual publish (optional)

- `pnpm -w changeset version`  
- `pnpm install`  
- `pnpm -w build`  
- `pnpm -w changeset publish`

---

## Adding a new package

Create `packages/<name>/` with:

```
packages/<name>/
├─ package.json
├─ tsconfig.json
├─ tsup.config.ts
├─ size-limit.json
├─ src/
│  └─ index.ts
└─ test/
   └─ index.test.ts
```

**package.json (example):**
```json
{
  "name": "@your-scope/<name>",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint ."
  }
}
```

**tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["dist", "coverage", "node_modules"]
}
```

**tsup.config.ts:**
```ts
import {defineConfig} from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false
})
```

**size-limit.json:**
```json
[
  { "name": "<name>", "path": ["dist/index.js"], "limit": "6 KB" }
]
```

---

## Linting & style

- Tabs, single quotes, no semicolons, max line length 100  
- No `any` in TypeScript (enforced)  
- Don’t import another package’s `/src/**` (use published exports)  
- Don’t use test helpers in runtime code

## Testing

- Put tests under `test/` or `**/*.test.ts`  
- Node environment by default  
- Coverage via V8; adjust thresholds per package if needed  
- Root Vitest config supports `passWithNoTests: true` so empty packages don’t fail CI

## CI

The GitHub Actions workflow calls `pnpm -w validate` so checks live in code, not YAML. It runs on push and pull requests for Node 20.x and 22.x.

## Troubleshooting

- **“GitHub Actions is not permitted to create or approve pull requests.”**  
  Use a PAT (classic) with `repo` scope as `RELEASE_TOKEN` and set `GITHUB_TOKEN: ${{ secrets.RELEASE_TOKEN }}` in the release job.

- **“No publish happened.”**  
  Ensure a changeset exists and that the **Version Packages** PR was merged into `main`.

- **“npm auth failed.”**  
  Check `NPM_TOKEN` secret (for token auth) or your npm “Trusted publishers” configuration (for OIDC).

- **“Package not found / 403 on first publish.”**  
  For scoped public packages, ensure `"publishConfig": { "access": "public" }`. For OIDC, you may need a one-time manual publish before switching fully to trusted publishing, depending on your npm org settings.

## License

MIT (change as needed).
