# Private Workspace Package

Use this archetype for internal tooling or support code that should participate in required workspace checks but never publish.

Expected contract:

- required scripts: `typecheck`, `build`
- omit publish-oriented scripts if they are irrelevant
- set `"private": true`
- keep any package-local complexity inside the package
