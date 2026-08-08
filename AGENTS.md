# Package Repository Guidance

## Scope

This repository is a production package monorepo. Keep public packages focused and maintain the mandatory core as generic infrastructure; place optional capability in manifest-driven modules and never hardcode Ooops Studio package names in generic template code.

## Required workflow

- After `pnpm init:template` or `pnpm bootstrap`, run `pnpm -w validate` before merging. In the uninitialized template with intentional placeholders, use `pnpm -w validate:ci`; it runs the template-safe profile.
- Run the smallest relevant package test during development; add unit tests for behavior, packed-artifact checks for publishable API changes, and installer smoke coverage for installer changes.
- Preserve manifest, registry, package-access, action-pinning and organization-policy guards. Update their tests when policy behavior changes.

## Package quality

- Keep public APIs intentional, documented, ESM-first and covered by export maps. Treat export-map changes as semver changes.
- Keep files focused. Split mixed-responsibility modules before they become difficult to review; do not create large catch-all scripts or duplicate helpers.
- Prefer existing scripts, archetypes and module manifests over one-off tooling.

## Avoid

- Do not bypass validation, weaken release/security checks, leak tokens, or add unreviewed dependencies.
- Do not copy package behavior between framework adapters; share it through a headless package.
- Do not add product-specific design, CMS, or application rules to this generic template.
