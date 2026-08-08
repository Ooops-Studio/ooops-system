# Adapter Package

Use this archetype for packages that wrap or adapt another runtime and therefore need peer dependencies.

Expected contract:

- required scripts: `typecheck`, `build`
- optional scripts: `test`, `size`, `publint`, `attw`
- peer dependencies declare the host framework or runtime
- package-local config owns any adapter-specific build or test behavior
