# Core Package Guidance

- Keep this package implementation-light: contracts, ports, tokens, clocks,
  small runtime utilities, and no product-domain services.
- Add a contract here only when at least two packages need it.
- Do not add adapters, framework imports, browser/private environment reads, or
  concrete errors/metrics/lifecycle/tracing implementations.
- Preserve ESM exports and add unit tests for every public runtime behavior.
