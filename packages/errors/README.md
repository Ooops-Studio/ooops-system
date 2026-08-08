# @ooopsstudio/errors

`@ooopsstudio/errors` normalizes, classifies, redacts, and reports application errors.

## Install

```sh
pnpm add @ooopsstudio/errors @ooopsstudio/core
```

## Presets

- `development`: reports locally and rethrows for immediate debugging.
- `production`: redacted reporting with deduplication, logging, metrics, tracing, and coordinated lifecycle hooks.
- `custom`: explicit escape hatch for a custom reporter, classifier, or sink.

```ts
import {registerErrors} from '@ooopsstudio/errors'
import {createSentryErrorSink} from '@ooopsstudio/errors/sentry'

await registerErrors(container, {
	preset: 'production',
	options: {
		sink: createSentryErrorSink({dsn: process.env.SENTRY_DSN!})
	}
})
```

The production sink is optional and best-effort. It receives a redacted error once; sink failures never interrupt the application or the built-in reporters. Sinks may implement `flush()` and `close()` for coordinated shutdown. Every flush accepted before shutdown is drained before the sink is closed. Pending callers plus detached physical flush and finalization generations have fixed admission bounds, and each flush drains a stable admission generation instead of chasing later work indefinitely.

Sentry DSNs must use HTTPS. Redirects are rejected, request timeouts are bounded to 60 seconds, and DSN credentials, raw transport failures, hostile tag accessors, and sensitive tag keys are never forwarded into diagnostics. Transport capabilities are captured when the sink is created, so later replacement of global `fetch` or `AbortController` cannot rewire an active sink. A timed-out capture aborts and detaches an uncooperative transport request so it cannot block `flush()` or `close()` indefinitely. The handler stops accepting new errors before shutdown and drains every accepted error before finalizing reporters. Failed or timed-out finalization keeps admission closed and can be retried with another `shutdown()` call.

`registerErrors()` requires a reversible container with `unbind()`. Registration verifies the retained instance and rolls back any partial `bind()` before releasing constructed lifecycle and reporter resources.

Redaction is always enabled. Tokens, credentials, common personal data—including IPv4/IPv6 addresses—URLs, deep objects, and oversized values are sanitized before reporting. Quoted assignments remain fail-closed when quotes are escaped or malformed, and generated identifier fingerprints remain stable across repeated delivery boundaries. Compound keys such as `awsSecretAccessKey`, `billingPhone`, and `actorUserId` are treated as sensitive. One immutable canonical snapshot is created at admission; integrations that receive the full error get isolated immutable projections without repeating hostile-object traversal.
Multi-part Authorization, Proxy-Authorization, Cookie, and Set-Cookie values—including folded continuations—are redacted as complete bounded header values rather than exposing trailing fields.

Production deduplication distinguishes error kinds and expires at the exact TTL boundary. A backwards-moving or invalid injected clock resets or falls back safely instead of suppressing errors indefinitely.

Only explicit validation failures are downgraded to validation-level diagnostics. Native programming failures such as `TypeError` and `ReferenceError` remain visible as errors; timeouts and network resets retain distinct `TIMEOUT` and `NETWORK` classifications. Classification uses bounded machine-token matching before public redaction, allowing custom registries to recognize identifiers such as `TokenExpiredError` without exposing those identifiers to reporters.

The service intentionally has no testing/minimal presets, retryable marker, retry queue, durable spool, policy pipeline, runtime health status, or dynamic rewiring API.

## 0.2 migration

- Replace `destroy()` with retryable `shutdown()`.
- Replace a custom `reportRuntime` with the `report` callback and/or an `ErrorSink`.
- Replace `errorDeduplicationCache` with built-in bounded deduplication and optional `ports.cache` storage.
- Error metrics now use only `errors_total{category,severity}`; dynamic metric names and the `code` label were removed.
- Production error-rate lifecycle degradation is no longer implicit. Applications own that operational policy explicitly.

## License

MIT. See the repository [LICENSE](../../LICENSE).
