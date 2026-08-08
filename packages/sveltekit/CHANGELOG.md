# @ooopsstudio/sveltekit

## 0.1.0

### Initial release

- SvelteKit 2 server instrumentation and Svelte 5 browser actions.
- Breaking: make `instrumentHandleError()` the sole Errors/logger owner.
- Project modern HTTP method/status attributes and correct 5xx span status from every HTTP wrapper.
- Make missing `IntersectionObserver` a no-op unless `fallback: "record"` is selected.
- Expand server composition, propagation, action lifecycle, and cleanup documentation.
