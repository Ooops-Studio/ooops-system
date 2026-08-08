# `@ooopsstudio/tracing`

Bounded distributed tracing with W3C propagation, mandatory redaction, and
resilient OTLP/HTTP delivery.

```bash
pnpm add @ooopsstudio/core @ooopsstudio/tracing
```

Tracing has three intentionally separate entry points. Prefer subpath imports so an application only bundles the runtime it uses.

```ts
import {createDevelopmentTracing} from '@ooopsstudio/tracing/development'
import {createProductionTracing} from '@ooopsstudio/tracing/production'
import {createCustomTracing} from '@ooopsstudio/tracing/custom'
```

Container-based applications can import `registerTracing` from the package
root. Integrations that only need correlation data should use the narrow
`@ooopsstudio/tracing/observability` entrypoint.

## Development

Development tracing samples every trace and writes redacted spans directly to the console. It has no remote destination, batching queue, retry, or persistence.

## Production

Production tracing requires one OTLP/HTTP collector:

```ts
const tracing = await createProductionTracing({
	remote: {
		endpoint: 'https://collector.example.com/v1/traces',
		headers: {authorization: 'Bearer <token>'}
	},
	resource: {serviceName: 'api', deploymentEnvironment: 'production'}
})
```

It uses fixed parent-based 10% sampling, W3C propagation, bounded batching, gzip, retries, circuit breaking, and delivery-rate protection. Headers are used only for the collector request. Redaction and value limits are always active.

Production endpoints must use HTTPS and must not use `localhost`, loopback, or
unspecified listener addresses. Development collectors on
plain HTTP remain possible only through the custom preset.

## Custom

Use custom tracing only when an application needs its own sampler, exporter, delivery mode, batching bounds, or delivery-resilience policy. It still accepts exactly one destination and always uses W3C propagation and mandatory redaction.
Custom destination, sampling, and delivery variants are closed discriminated
policies: unknown or mixed variants fail at bootstrap instead of falling back to
a different sink, sampling strategy, or processor mode.
Public operation helpers pre-bound custom attributes to 128 keys and 8 KiB, and
insert canonical semantic fields first so caller-controlled attribute floods
cannot evict or override them at the span boundary.
Observability resource composition follows the same canonical-first rule within
its 64-key budget, preserving service identity and deployment attribution even
when custom resource attributes fill the available capacity.
Header-extraction scopes, explicit roots, explicit parents from another trace,
and external-span activation never inherit ambient baggage. Local baggage crosses
an activation only when the parent is implicit or remains within the same trace.
Baggage values and OTLP header values apply character lower-bound checks before
UTF-8 sizing or percent encoding, so oversized strings cannot trigger allocations
proportional to data that will be rejected by the configured byte limits.

Tracing is best-effort telemetry. It intentionally has no disk spool, memory exporter, raw span snapshots, multi-export fan-out, NDJSON, or legacy propagation formats.

## Internal functional boundaries

- `core/tracer.ts` owns the public tracing port and async context composition.
- `core/tracer-admission.ts` owns lifecycle-aware admission and sampling.
- `core/tracer-observability.ts` owns isolated exception, breadcrumb, and external-link helpers.
- `core/tracer-span-tools.ts` owns span construction, activation, finalization, and self-metrics.
- `core/tracer-propagation.ts` owns W3C extraction/injection and baggage context.
- `core/span-recorder.ts` owns bounded mutable span state and immutable final records.
- `core/simple-processor.ts` and `core/batching-processor.ts` own direct and queued delivery independently.
- `core/transferring.ts` owns retry, timeout, rate protection, and circuit-breaking for exporters.
- `features/propagation`, `features/redaction`, `features/resources`, and `features/exporters` contain independent protocol features.
- `public/*` owns preset composition and lifecycle hook registration.

Exporter diagnostics are isolated from span completion. Partial batch exports
account only for the unaccepted remainder. Shutdown closes admission permanently;
a failed finalization remains `draining` and may retry only unfinished cleanup.
Public flushes, processor drain, and exporter cleanup are bounded, and cleanup is
attempted even when delivery fails or an application-owned span never ends. A
timed-out, still-indeterminate exporter shutdown remains single-flight across
cleanup retries. A successful shutdown is terminal. Mandatory redaction fails
closed even for hostile attribute containers and sensitive event names.

Custom redaction string keys are limited to 256 characters. Regular-expression
key rules are limited to 64, bounded, and repetition-free because JavaScript cannot place
a synchronous execution deadline on a potentially backtracking expression.
Exact string rules use a compiled lookup while preserving first-match ordering
against regex rules.
Truncation is linear and its complete marker-bearing result remains inside the
configured UTF-8 byte limit.

Processor and resilient-exporter admission snapshot and freeze span records before
the first asynchronous hop. Recursive attribute snapshots enforce both structural
limits, a total graph-node budget, and aggregate string/key budgets to prevent
shared-reference and serialization-allocation amplification. The HTTP exporter
repeats that admission check as an independent sink boundary.
Attribute, baggage, and propagation-carrier boundaries accept only plain or
null-prototype data objects, so inherited keyspaces cannot run ahead of their
bounded own-field scans.
Propagation rejects oversized raw headers before UTF-8 encoding or parsing.
Injection validates the replacement context and carrier capacity before removing
stale tracing headers, so a rejected replacement preserves the usable carrier.
Implicit span end timestamps clamp a regressed epoch clock to the span start,
preventing host clock corrections from discarding otherwise valid spans.
Flush barriers retain failure ownership: failures admitted after a direct barrier,
or non-batch failures observed while a batch barrier is active, remain visible to
the next flush instead of being consumed by the earlier call.
Malformed HTTP 2xx acknowledgements are terminal: the collector may already have
committed the batch, so retrying could duplicate spans.

## License

MIT. See the repository license for details.
