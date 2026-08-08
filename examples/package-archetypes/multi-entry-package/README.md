# Multi-Entry Package

Use this archetype when one package owns several public subpaths.

Expected contract:

- required scripts: `typecheck`, `build`
- optional scripts: `test`, `size`, `publint`, `attw`
- package-local `tsup` config defines the entry map
- package-local size config can use `.mjs` when JSON is too limited
- package-local Vitest config can merge the shared root base
