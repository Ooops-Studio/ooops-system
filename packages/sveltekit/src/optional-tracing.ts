import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import type {SpanOptions, Tracing, TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {measureAsyncOperation} from '@ooopsstudio/sdk/performance'

type InSpanMethod = Tracing['inSpan']
type CapturedTracing = {method: InSpanMethod; pending: number}

const MAX_PENDING_TRACING_CALLS = 100
const capturedTracing = new WeakMap<object, CapturedTracing>()

const captureInSpan = (tracing: Pick<Tracing, 'inSpan'> | undefined): CapturedTracing | undefined => {
	if (!tracing || typeof tracing !== 'object') return undefined
	try {
		const cached = capturedTracing.get(tracing)
		if (cached) return cached
		let owner: object | null = tracing
		for (let depth = 0; owner && depth < 32; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'inSpan')
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const captured = {method: descriptor.value as InSpanMethod, pending: 0}
				capturedTracing.set(tracing, captured)
				return captured
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

const trackPromise = (value: unknown, captured: CapturedTracing): void => {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
	captured.pending += 1
	const release = (): void => { captured.pending -= 1 }
	try { void Reflect.apply(Promise.prototype.then, value, [release, release]) } catch {
		// Non-Promise tracing results are ignored without thenable assimilation.
		release()
	}
}

/** Runs application work exactly once while treating tracing as optional. */
export async function runWithOptionalTracing<TResult>(
	tracing: Pick<Tracing, 'inSpan'> | undefined,
	name: string,
	operation: (span?: TracingSpan) => Promise<TResult>,
	options?: SpanOptions
): Promise<TResult> {
	const captured = captureInSpan(tracing)
	let activeSpan: TracingSpan | undefined
	const performance: PerformancePort | undefined = captured
		? {
			measureAsync: (_name, invoke) => {
				if (captured.pending >= MAX_PENDING_TRACING_CALLS) return undefined as never
				const instrumentation = Reflect.apply(captured.method, tracing, [
					name,
					async(span: TracingSpan) => {
						activeSpan = span
						return await invoke()
					},
					options
				])
				trackPromise(instrumentation, captured)
				return instrumentation as never
			}
		}
		: undefined
	return await measureAsyncOperation(performance, name, async() => await operation(activeSpan))
}
