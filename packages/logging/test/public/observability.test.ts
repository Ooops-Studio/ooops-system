import {describe, expect, it, vi} from 'vitest'

import {
	buildObservabilityLogContext,
	createTraceCorrelationProvider,
	getTraceCorrelation,
	observabilityResourceToLogAttributes
} from '../../src/public/observability'

describe('logging observability helpers', () => {
	it('maps observability resources into log attributes', () => {
		expect(observabilityResourceToLogAttributes({
			serviceName: 'studio-app',
			serviceVersion: '1.2.3',
			deploymentEnvironment: 'production',
			hostKind: 'studio',
			runtime: 'node'
		})).toEqual({
			'service.name': 'studio-app',
			'service.version': '1.2.3',
			'deployment.environment': 'production',
			'service.host_kind': 'studio',
			'service.runtime': 'node'
		})
		expect(observabilityResourceToLogAttributes({
			serviceName: 42, serviceVersion: true, runtime: {secret: true}
		} as never)).toEqual({})
	})

	it('merges observability resource attributes into log context', () => {
		expect(buildObservabilityLogContext(
			{attributes: {requestId: 'req-1'}},
			{serviceName: 'cms-app'}
		)).toEqual({
			attributes: {
				requestId: 'req-1',
				'service.name': 'cms-app'
			}
		})
	})

	it('masks hostile observability attributes instead of throwing', () => {
		const resourceAttributes = {}
		Object.defineProperty(resourceAttributes, 'secret', {
			enumerable: true,
			get() {
				throw new Error('resource attribute failed')
			}
		})
		const contextAttributes = new Proxy({requestId: 'req-1'}, {
			ownKeys() {
				throw new Error('context attributes failed')
			}
		})

		expect(observabilityResourceToLogAttributes({
			serviceName: 'cms-app',
			attributes: resourceAttributes as never
		})).toEqual({
			'service.name': 'cms-app',
			secret: '[Unserializable]'
		})
		expect(buildObservabilityLogContext(
			{attributes: contextAttributes as never},
			{serviceName: 'cms-app'}
		)).toEqual({
			attributes: {
				unserializableAttributes: '[Unserializable]',
				'service.name': 'cms-app'
			}
		})
	})

	it('creates trace correlation from tracing ports', async() => {
		const tracing = {
			currentTraceId: vi.fn(() => 'trace-1'),
			getActiveSpan: vi.fn(() => ({
				getContext: () => ({traceId: 'trace-1', spanId: 'span-1'})
			}))
		}
		expect(getTraceCorrelation(tracing)).toEqual({traceId: 'trace-1', spanId: 'span-1'})
		expect(await createTraceCorrelationProvider(tracing)({} as never)).toEqual({
			traceId: 'trace-1',
			spanId: 'span-1'
		})
	})

	it('returns passthrough or empty values when resource or tracing data is absent', async() => {
		expect(buildObservabilityLogContext(undefined, undefined)).toBeUndefined()
		expect(buildObservabilityLogContext({attributes: {requestId: 'req-1'}}, undefined)).toEqual({
			attributes: {requestId: 'req-1'}
		})
		expect(getTraceCorrelation()).toBeUndefined()
		expect(getTraceCorrelation({
			currentTraceId: vi.fn(() => undefined)
		})).toBeUndefined()
		expect(getTraceCorrelation({
			currentTraceId: vi.fn(() => 'trace-only')
		})).toEqual({traceId: 'trace-only'})
		expect(getTraceCorrelation({
			currentTraceId: vi.fn(() => undefined),
			getActiveSpan: vi.fn(() => ({
				getContext: () => ({spanId: 'span-only'})
			}))
		})).toEqual({spanId: 'span-only'})
		expect(await createTraceCorrelationProvider(undefined)({} as never)).toEqual({})
	})

	it('isolates hostile tracing ports and preserves whichever correlation field remains available', async() => {
		const traceFailure = {
			currentTraceId() { throw new Error('trace lookup failed') },
			getActiveSpan: () => ({getContext: () => ({spanId: 'span-safe'})})
		}
		expect(getTraceCorrelation(traceFailure as never)).toEqual({spanId: 'span-safe'})

		const spanFailure = {
			currentTraceId: () => 'trace-safe',
			getActiveSpan: () => ({getContext() { throw new Error('span lookup failed') }})
		}
		expect(getTraceCorrelation(spanFailure as never)).toEqual({traceId: 'trace-safe'})

		const hostile = new Proxy({}, {
			get() { throw new Error('hostile tracing proxy') }
		})
		expect(getTraceCorrelation(hostile as never)).toBeUndefined()
		expect(await createTraceCorrelationProvider(hostile as never)({} as never)).toEqual({})

		const traceGetter = vi.fn(() => () => 'must-not-run')
		const accessorTracing = Object.defineProperty({}, 'currentTraceId', {get: traceGetter})
		expect(getTraceCorrelation(accessorTracing as never)).toBeUndefined()
		expect(traceGetter).not.toHaveBeenCalled()

		expect(getTraceCorrelation({
			currentTraceId: () => '   ',
			getActiveSpan: () => ({getContext: () => ({spanId: ' span-safe '})})
		} as never)).toEqual({spanId: 'span-safe'})
		expect(getTraceCorrelation({currentTraceId: () => 'x'.repeat(129)} as never)).toBeUndefined()
	})

	it('observes rejected asynchronous correlation capabilities', async() => {
		let handledRejections = 0
		const rejectedThenable = () => ({
			then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
				handledRejections += 1
				reject(new Error('async correlation failure'))
			}
		})

		expect(getTraceCorrelation({
			currentTraceId: rejectedThenable,
			getActiveSpan: () => ({getContext: () => ({spanId: 'span-safe'})})
		} as never)).toEqual({spanId: 'span-safe'})
		expect(getTraceCorrelation({
			currentTraceId: () => 'trace-safe',
			getActiveSpan: rejectedThenable
		} as never)).toEqual({traceId: 'trace-safe'})
		expect(getTraceCorrelation({
			getActiveSpan: () => ({getContext: rejectedThenable})
		} as never)).toBeUndefined()

		await new Promise<void>((resolve) => { setImmediate(resolve) })
		expect(handledRejections).toBe(3)
	})
})
