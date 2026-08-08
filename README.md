# Ooops System

Foundation, observability and operational runtime packages for the Ooops System
TypeScript platform. The workspace publishes 17 focused packages and validates
their package graph, public exports and packed artifacts as one release unit.

## Requirements

- Node 22.14.0 or newer
- pnpm 11.20.0

## Quick start

1. Install dependencies with `pnpm install`.
2. Run `pnpm validate`.
3. Run package-specific commands with `pnpm --filter @ooopsstudio/<package> <script>`.

## Workspace contract

The root workspace orchestrates packages. Packages own their own tool choices.

Required package scripts:

- `typecheck`
- `build`

Optional package scripts:

- `test`
- `size`
- `publint`
- `attw`

That means the root contract scales without assuming that every package has one entrypoint, one export map shape, or one publish profile.

## What’s inside

- Shared TypeScript base config
- Shared ESLint flat config
- Shared Vitest base config for package-local merges
- Generic dependency-cruiser baseline
- Local CI and release workflows
- Strict publish, package-graph, license, size, type and artifact checks
- Changesets and npm trusted-publishing release workflow
- Package archetypes and migration tools for future system domains

## Published packages

| Package | Purpose |
| --- | --- |
| `@ooopsstudio/core` | Foundation contracts, ports, tokens and runtime utilities |
| `@ooopsstudio/audit` | Immutable, redacted audit evidence and integrity verification |
| `@ooopsstudio/bridges` | Explicit, bounded cross-domain integrations |
| `@ooopsstudio/cache` | Cache-aside runtime with memory and Redis backends |
| `@ooopsstudio/errors` | Error normalization, redaction, reporting and Sentry delivery |
| `@ooopsstudio/events` | Durable, schema-validated event publication and consumption |
| `@ooopsstudio/jobs` | Task scheduling and durable background job execution |
| `@ooopsstudio/lifecycle` | Startup, health, drain and shutdown orchestration |
| `@ooopsstudio/logging` | Structured logging, sinks, delivery and redaction |
| `@ooopsstudio/metrics` | Metrics aggregation, Prometheus and OTLP delivery |
| `@ooopsstudio/performance` | Server performance measurement, budgets and runtime monitoring |
| `@ooopsstudio/profiling` | Bounded CPU profiling with Inspector and Pyroscope integrations |
| `@ooopsstudio/rate-limit` | Fixed-window and token-bucket limiting with memory and Redis backends |
| `@ooopsstudio/resilience` | Timeout, retry, circuit-breaker, bulkhead and request coalescing |
| `@ooopsstudio/sdk` | Framework-agnostic developer helpers built on the core contracts |
| `@ooopsstudio/sveltekit` | SvelteKit observability adapters and browser actions |
| `@ooopsstudio/tracing` | Distributed tracing, W3C propagation and OTLP delivery |

Repository-level scripts, policies and archetypes live outside `packages/` and
enforce the common build, test, release and package-quality contract.

## Common scripts

- `pnpm -w lint` — lint shared root files plus package and example config files
- `pnpm -w typecheck` — run required package `typecheck` scripts recursively
- `pnpm -w build` — run required package `build` scripts recursively
- `pnpm -w test` — run package `test` scripts when present
- `pnpm -w size` — run package `size` scripts when present
- `pnpm -w depcruise` — run dependency-cruiser against workspace source
- `pnpm bootstrap` — install dependencies and run the template bootstrap flow in one command
- `pnpm init:template` — replace the controlled template placeholders, update repository metadata, and optionally rename the starter package directory
- `pnpm -w check:manifests` — validate package manifest policy for public and private workspace packages
- `pnpm -w publint` — run package `publint` scripts when present
- `pnpm -w attw` — run package `attw` scripts when present
- `pnpm -w check:packed-artifacts` — pack the complete publishable package graph, install sibling tarballs with temporary overrides, and verify imports, framework-adapter types, and tarball contents
- `pnpm -w readiness` — generate an advisory package-readiness report
- `pnpm -w readiness:json` — emit the package-readiness report as JSON
- `pnpm -w readiness:strict` — fail on packages that need review or are blocked
- `pnpm -w check:licenses` — verify installed dependency licenses against `license-policy.json`
- `pnpm -w audit:prod` — blocking production dependency audit
- `pnpm -w audit:dev` — development dependency audit; CI runs it as non-blocking warning by default
- `pnpm -w release:preflight` — verify publish credentials or trusted publishing assumptions before release
- `pnpm -w publish:packages -- --dry-run` — preview the registry-aware package publish targets without publishing
- `pnpm -w create:package -- --name @your-scope/example --archetype public-package` — create a new package from an archetype
- `pnpm -w copy:package -- --from ../other-repo/packages/example` — copy a package into `packages/` and normalize obvious workspace-only fields. External targets require both `--allow-external-target` and `--force`.
- `pnpm -w deprecate:package -- --package @your-scope/old-package` — dry-run npm deprecation guidance for a package; add `--execute` to run `npm deprecate`
- `pnpm -w validate:ci` — run template-safe CI before bootstrap and automatically switch to full `validate` after bootstrap
- `pnpm -w guard:template` — fail fast if publish-facing manifests still contain placeholders
- `pnpm -w smoke:archetypes` — verify the documented package archetype examples stay in sync
- `pnpm -w validate` — the strict initialized-repo quality contract used locally and in release workflows

Filter by package: `pnpm -w -F @your-scope/<pkg> <script>`

## Package archetypes

The template supports four generic package shapes without making the repo domain-specific:

- **Public package**: publishable single-entry library. See `packages/core/` and `examples/package-archetypes/public-package/`.
- **Private workspace package**: internal support code that participates in required checks but omits publish-oriented scripts. See `examples/package-archetypes/private-workspace/`.
- **Multi-entry package**: one package with multiple public subpaths and package-local entry mapping. See `examples/package-archetypes/multi-entry-package/`.
- **Adapter package**: publishable package with peer dependencies and package-local overrides. See `examples/package-archetypes/adapter-package/`.

These examples are intentionally not part of the workspace. They document supported expansion paths without forcing those shapes into every generated repo.

## Shared defaults and package-local overrides

The root configs are shared defaults, not rigid rules.

Use package-local config when a package needs to diverge:

- **Vitest**: create `packages/<name>/vitest.config.ts` and merge from the root base.
- **tsup**: keep build entry maps in `packages/<name>/tsup.config.ts`.
- **size-limit**: use `.json` for simple packages and `.mjs` when the config needs logic or multiple budgets.
- **peer dependencies**: declare them only in the packages that need adapter-style host integration.
- **dependency-cruiser layering**: extend the generic baseline with repo-specific import rules when your package graph needs stricter architecture enforcement.

## Publish safety checks

The template includes two generic publish-oriented checks beyond `publint` and `attw`:

- **Manifest policy** checks package metadata for publishable packages:
  - `license`
  - `repository`
  - `homepage`
  - `bugs.url`
  - `engines.node`
  - `files`
  - `exports`
  - `publishConfig.access` for scoped public packages
- **Packed artifact smoke test** verifies the actual tarball:
  - `pnpm pack` succeeds
  - the tarball contains built files under `dist/`
  - the tarball omits `src/`, `test/`, and `coverage/`
  - a temp consumer can install the tarball
  - Node can import every exported specifier
  - TypeScript can resolve every exported specifier

## When to override root defaults

Stay with the root defaults when the package is a straightforward library.

Override locally when the package has one of these traits:

- multiple public subpath exports
- browser vs server entrypoints
- peer dependencies
- special size budgets
- stricter or package-specific test setup
- custom dependency-layering rules

The root should stay orchestration-only. Package-specific complexity should stay package-local.

## Adding a new package

Start with the minimum package interface:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsup"
  }
}
```

Then add optional scripts only if the package needs them:

```json
{
  "scripts": {
    "test": "vitest run",
    "size": "size-limit --config .size-limit.json",
    "publint": "publint",
    "attw": "attw --pack --ignore-rules no-resolution --ignore-rules cjs-resolves-to-esm"
  }
}
```

Use the archetype examples when choosing a package shape instead of copying the demo package blindly.

## Optional tooling installer

This repository was generated from a mandatory core plus optional tooling modules. Re-run `pnpm init:template -- --dry-run` to preview changes before reconfiguring the template.

Registry strategy: `npm`

Enabled module state:

- `dependency-cruiser` — enabled; Dependency graph architecture checks.
- `license-policy` — enabled; Dependency license policy, checker script, and schema.
- `migration-tools` — enabled; Scripts for creating packages and copying packages from another monorepo.
- `organization-policy` — disabled; Configurable dependency, peer range, import direction, and source-pattern rules.
- `package-readiness` — enabled; Advisory or strict release-readiness reports for publishable packages.
- `publint-attw` — enabled; publint and Are The Types Wrong package compatibility checks.
- `registry-github` — disabled; Optional GitHub Packages publishing and consumer registry documentation.
- `release` — enabled; Changesets release workflow, publish preflight, and release documentation.
- `renovate` — enabled; Weekly dependency update automation for npm, pnpm lockfile, and GitHub Actions.
- `security-audit` — enabled; Production and development dependency audit scripts and CI jobs.
- `size-limit` — enabled; Package-level size-limit scripts, configs, and dev dependencies.

Disabled modules are removed by default from scripts, workflows, docs and files. Use `--no-cleanup` when you want to leave optional source files in place for later.


## Dependency automation

Renovate is enabled by default for this generated repository. It runs weekly for npm/pnpm dependencies, lockfile maintenance, and GitHub Actions updates. Automerge is disabled so maintainers review updates before merging.

## Security checks

- `pnpm -w audit:prod` blocks CI on production advisories at `moderate` or higher.
- `pnpm -w audit:dev` blocks CI for development dependency advisories.
- `pnpm -w check:licenses` blocks validation when installed packages use licenses outside `license-policy.json`.

## Release safety

This repository publishes to npm through GitHub OIDC trusted publishing; it does not store a long-lived `NPM_TOKEN`. Each npm package trusts `ooops-studio/ooops-system` and `.github/workflows/release.yml`, while the workflow grants `id-token: write` only to the publish job. The repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true` is an explicit bootstrap gate. A push to `main` validates the workspace and publishes every package version that is not already on npm. Version changes are prepared and reviewed with `pnpm changeset version` before they reach `main`. Manual `workflow_dispatch` defaults to validation-only mode.

Recommended branch protection:

- Protect `main`.
- Require CI to pass before merge.
- Require review for version changes generated with Changesets.
- Disable direct pushes to `main`.

## Package readiness

Package readiness is enabled as a strict release gate. It summarizes package metadata, docs, export surface, packed size, quality scripts, changeset state and public-facing leakage warnings.

```sh
pnpm -w readiness
pnpm -w readiness:json
pnpm -w readiness:strict
```

Use `package-readiness.config.json` to adjust thresholds for large intentional packages, for example service suites with many public subpaths.

## For internal package splits

This template can extract reusable packages from larger monorepos into focused package repos, for example `ooops-suite` to `ooops-stage-packages` or `ooops-analytics-packages`.

```sh
pnpm -w copy:package -- --from ../ooops-suite/packages/stage-api
pnpm -w create:package -- --name @your-scope/new-package --archetype public-package
pnpm -w deprecate:package -- --package @your-scope/old-package
```

Migration scripts support dry-run behavior and never commit changes. The deprecation helper is dry-run by default and only calls `npm deprecate` when `--execute` is passed.


## CI and release

The bundled GitHub Actions workflows are local to the repository.

- CI uses `pnpm -w validate:ci`, which is template-aware:
  - before bootstrap it runs a template-safe profile so the fresh template repo stays green
  - after bootstrap it automatically runs the full `pnpm -w validate` pipeline
- CI also runs `pnpm -w audit:prod` as blocking and `pnpm -w audit:dev` as blocking.
- Release stays strict and always uses `pnpm -w validate`.
- Release uses npm trusted publishing with GitHub OIDC, runs `pnpm -w release:preflight` before publish, and supports manual dry-run validation through `workflow_dispatch`.
- Package publishing uses registry strategy `npm`.

## Troubleshooting

- **“I want the shortest possible onboarding path.”**
  Run `pnpm bootstrap`. It installs dependencies, infers defaults from git and the current folder name when possible, then runs the same bootstrap flow as `pnpm init:template`.

- **“I want to bootstrap the generated repo without editing files manually.”**
  Run `pnpm init:template`. It prompts for scope, repository, package names, and starter package directory, and it can run non-interactively with flags or preview changes with `--dry-run`.

- **“Install warned that build scripts were ignored.”**
  Run `pnpm approve-builds` and approve the packages your environment needs, or configure pnpm’s build-script policy for CI and local development.

- **“validate fails immediately with placeholder errors.”**
  Replace the placeholder values in the manifest files called out by `pnpm -w guard:template`.

- **“How are package versions advanced?”**
  Add Changesets with `pnpm changeset`, then run and review `pnpm changeset version` before merging the release commit into `main`. The push-triggered workflow publishes the resulting unpublished versions.

- **“A package needs more complex config than the demo package.”**
  Use one of the archetype examples under `examples/package-archetypes/` and keep the extra complexity inside that package.

## License

MIT (change as needed).
