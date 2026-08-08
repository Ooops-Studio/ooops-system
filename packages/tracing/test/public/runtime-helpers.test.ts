import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {createAlwaysOnSampler} from '@ooopsstudio/core/utils/tracing'
import {describe, expect, it, vi} from 'vitest'

import {TelemetryManager} from '../../src/core/telemetry'
import {createCustomTracingRuntime} from '../../src/public/custom-runtime'
import {registerTracingLifecycle} from '../../src/public/lifecycle-wiring'
import {getActiveSpanContext, getTraceCorrelation, observabilityResourceToDetectionOptions, observabilityResourceToTracingResource} from '../../src/public/observability'
import {snapshotCustomOptions, snapshotProductionOptions} from '../../src/public/options'
import {createStandardTracingRuntime} from '../../src/public/standard-runtime'
import {captureCapability} from '../../src/utils/capabilities'
import {validateLimits, validateResilienceConfig, validateRetryPolicy, validateSamplingRatio, validateTracerOptions} from '../../src/utils/config-validation'

describe('tracing runtime helpers', () => {
	it('bounds preset snapshot work for very wide OTLP headers', () => {
		let descriptorReads = 0
		const headers = new Proxy(
			Object.fromEntries(Array.from({length: 10_000}, (_, index) => [`x-header-${index}`, 'value'])),
			{
				getOwnPropertyDescriptor: (target, key) => {
					descriptorReads++
					return Reflect.getOwnPropertyDescriptor(target, key)
				}
			}
		)
		expect(() => snapshotProductionOptions({
			remote: {endpoint: 'https://collector.example/v1/traces', headers}
		})).toThrow('at most 100 fields')
		expect(descriptorReads).toBeLessThanOrEqual(202)
	})
	it('bounds preset snapshot work for very wide resource attributes', () => {
		let descriptorReads = 0
		const attributes = new Proxy(
			Object.fromEntries(Array.from({length: 10_000}, (_, index) => [`resource-${index}`, 'value'])),
			{getOwnPropertyDescriptor: (target, key) => {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}}
		)
		expect(() => snapshotCustomOptions({
			clock: createFixedClock(0), destination: {provider: 'custom', exporter: {export: async() => undefined}},
			resource: {serviceName: 'api', attributes}
		})).toThrow('resource attributes')
		expect(descriptorReads).toBeLessThanOrEqual(514)
	})
	it('rejects oversized configuration keys before retaining them', () => {
		const oversizedKey = 'x'.repeat(1_000_000)
		expect(() => snapshotProductionOptions({[oversizedKey]: true})).toThrow('closed plain data object')
		expect(() => snapshotCustomOptions({
			resource: {serviceName: 'api', attributes: {[oversizedKey]: 'value'}}
		})).toThrow('resource attributes')
		expect(() => snapshotProductionOptions({
			remote: {endpoint: 'https://collector.example/v1/traces', headers: {[oversizedKey]: 'value'}}
		})).toThrow('at most 100 fields')
	})
	it('bounds hostile cyclic prototype capability lookup', () => {
		let prototypeReads = 0
		let cyclic!: object
		cyclic = new Proxy({}, {
			getPrototypeOf: () => { prototypeReads++; return cyclic }
		})

		expect(captureCapability(cyclic, 'missing')).toBeUndefined()
		expect(prototypeReads).toBe(0)
	})
	it('projects active correlation and observability resources', () => {
		const context = {traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}
		const tracing = {getActiveSpan: () => ({getContext: () => context}), currentTraceId: () => 'fallback'} as never
		expect(getActiveSpanContext(tracing)).toEqual(context)
		expect(getActiveSpanContext(tracing)).not.toBe(context)
		expect(getTraceCorrelation(tracing)).toEqual(context)
		expect(getTraceCorrelation({getActiveSpan: () => undefined, currentTraceId: () => undefined} as never)).toBeUndefined()
		const resource = {serviceName: 'api', serviceVersion: '1', deploymentEnvironment: 'prod', hostKind: 'worker', runtime: 'node', attributes: {region: 'eu'}} as const
		expect(observabilityResourceToTracingResource(resource)).toMatchObject({'service.name': 'api', 'service.version': '1', region: 'eu'})
		expect(observabilityResourceToTracingResource({serviceName: 'api', attributes: {'service.name': 'spoofed'}})).toMatchObject({'service.name': 'api'})
		expect(getTraceCorrelation({getActiveSpan: () => { throw new Error('broken') }, currentTraceId: () => { throw new Error('broken') }} as never)).toBeUndefined()
		expect(observabilityResourceToDetectionOptions(resource)).toMatchObject({serviceName: 'api', runtimeType: 'node'})
		expect(observabilityResourceToTracingResource()).toBeUndefined()
		expect(observabilityResourceToDetectionOptions()).toBeUndefined()
		const flooded = observabilityResourceToTracingResource({
			serviceName: 'canonical-api',
			serviceVersion: '2',
			deploymentEnvironment: 'production',
			attributes: Object.fromEntries(Array.from({length: 100}, (_, index) => [`custom.${index}`, index]))
		})!
		expect(flooded).toMatchObject({
			'service.name': 'canonical-api',
			'service.version': '2',
			'deployment.environment': 'production'
		})
		expect(Object.keys(flooded).length).toBeLessThanOrEqual(64)
		let getterCalls = 0
		const hostile = Object.defineProperty({}, 'serviceName', {
			enumerable: true,
			get: () => { getterCalls++; return 'api' }
		})
		expect(() => observabilityResourceToTracingResource(hostile as never)).toThrow('closed safe data object')
		expect(getterCalls).toBe(0)
	})

	it('does not invoke accessor-backed tracing correlation capabilities', () => {
		let reads = 0
		const tracing = Object.defineProperties({}, {
			getActiveSpan: {enumerable: true, get: () => { reads++; return () => undefined }},
			currentTraceId: {enumerable: true, get: () => { reads++; return () => 'a'.repeat(32) }}
		})
		expect(getActiveSpanContext(tracing as never)).toBeUndefined()
		expect(getTraceCorrelation(tracing as never)).toBeUndefined()
		expect(reads).toBe(0)
	})

	it('reports and rethrows lifecycle flush and shutdown failures', async() => {
		let shutdown!: () => Promise<void>; let flush!: () => Promise<void>
		const lifecycle = {
			registerShutdownHook: vi.fn((_group, hook) => { shutdown = hook }),
			registerFlushHook: vi.fn((_group, hook) => { flush = hook })
		}
		const report = vi.fn()
		registerTracingLifecycle(lifecycle as never, {
			shutdown: vi.fn(async() => { throw new Error('shutdown') }),
			forceFlush: vi.fn(async() => { throw new Error('flush') })
		} as never, {report} as never, 'custom')
		await expect(shutdown()).rejects.toThrow('shutdown')
		await expect(flush()).rejects.toThrow('flush')
		expect(report).toHaveBeenCalledTimes(2)
		registerTracingLifecycle(undefined, {} as never, undefined, 'none')
	})

	it('disposes an already-registered shutdown hook when lifecycle wiring cannot finish', () => {
		const disposeShutdown = vi.fn()
		const lifecycle = {
			registerShutdownHook: vi.fn(() => disposeShutdown),
			registerFlushHook: vi.fn(() => { throw new Error('flush registration failed') })
		}
		expect(() => registerTracingLifecycle(lifecycle as never, {} as never, undefined, 'production'))
			.toThrow('flush registration failed')
		expect(disposeShutdown).toHaveBeenCalledOnce()
	})

	it('preserves registration and cleanup outcomes when lifecycle disposers throw', () => {
		const failingShutdownDisposer = vi.fn(() => { throw new Error('shutdown disposer failed') })
		expect(() => registerTracingLifecycle({
			registerShutdownHook: vi.fn(() => failingShutdownDisposer),
			registerFlushHook: vi.fn(() => { throw new Error('flush registration failed') })
		} as never, {} as never, undefined, 'production')).toThrow('flush registration failed')
		expect(failingShutdownDisposer).toHaveBeenCalledOnce()

		const dispose = registerTracingLifecycle({
			registerShutdownHook: vi.fn(() => () => { throw new Error('shutdown cleanup failed') }),
			registerFlushHook: vi.fn(() => () => { throw new Error('flush cleanup failed') })
		} as never, {} as never, undefined, 'custom')
		expect(() => dispose()).not.toThrow()
		expect(() => dispose()).not.toThrow()
	})

	it('returns an idempotent disposer for successfully registered shutdown hooks', () => {
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
		const dispose = registerTracingLifecycle({
			registerShutdownHook: vi.fn(() => disposeShutdown),
			registerFlushHook: vi.fn(() => disposeFlush)
		} as never, {} as never, undefined, 'custom')
		dispose(); dispose()
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
	})

	it('releases the lifecycle shutdown hook after a successful runtime shutdown', async() => {
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
		let shutdownHook!: () => Promise<void>
		const processor = {
			onEnd: vi.fn(), flush: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined), setObserver: vi.fn()
		}
		const tracer = await createCustomTracingRuntime({
			clock: createFixedClock(0), sampler: createAlwaysOnSampler(), processor,
			lifecycle: {
				registerShutdownHook: vi.fn((_group, hook) => { shutdownHook = hook; return disposeShutdown }),
				registerFlushHook: vi.fn(() => disposeFlush)
			} as never
		})
		await shutdownHook()
		await tracer.shutdown?.()
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
	})

	it('awaits runtime cleanup when lifecycle registration fails', async() => {
		let releaseShutdown!: () => void
		const processor = {
			onEnd: vi.fn(), flush: vi.fn(async() => undefined),
			shutdown: vi.fn(() => new Promise<void>((resolve) => { releaseShutdown = resolve })),
			setObserver: vi.fn()
		}
		const pending = createCustomTracingRuntime({
			clock: createFixedClock(0), sampler: createAlwaysOnSampler(), processor,
			lifecycle: {
				registerShutdownHook: vi.fn(() => vi.fn()),
				registerFlushHook: vi.fn(() => { throw new Error('flush registration failed') })
			} as never
		})
		let settled = false
		void pending.finally(() => { settled = true }).catch(() => undefined)
		await vi.waitFor(() => expect(processor.shutdown).toHaveBeenCalledOnce())
		expect(settled).toBe(false)
		releaseShutdown()
		await expect(pending).rejects.toThrow('flush registration failed')
	})

	it('preserves lifecycle registration and runtime cleanup failures', async() => {
		await expect(createCustomTracingRuntime({
			clock: createFixedClock(0), sampler: createAlwaysOnSampler(),
			processor: {
				onEnd: vi.fn(), flush: vi.fn(async() => undefined),
				shutdown: vi.fn(async() => { throw new Error('processor cleanup failed') }),
				setObserver: vi.fn()
			},
			lifecycle: {
				registerShutdownHook: vi.fn(() => vi.fn()),
				registerFlushHook: vi.fn(() => { throw new Error('flush registration failed') })
			} as never
		})).rejects.toThrow('initialization and cleanup both failed')
	})

	it('preserves pre-tracer assembly and processor cleanup failures', async() => {
		const shutdown = vi.fn(async() => { throw new Error('processor cleanup failed') })
		await expect(createCustomTracingRuntime({
			clock: createFixedClock(0),
			sampler: createAlwaysOnSampler(),
			processor: {
				onEnd: vi.fn(), flush: vi.fn(async() => undefined), shutdown,
				setObserver: vi.fn()
			},
			resource: {serviceName: 42} as never
		})).rejects.toThrow('initialization and cleanup both failed')
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('validates every public configuration family', () => {
		const snapshotted = snapshotCustomOptions({
			clock: createFixedClock(0),
			destination: {provider: 'custom', exporter: {export: async() => undefined}},
			resource: {serviceName: 'api', attributes: {region: 'eu'}},
			limits: {maxAttributesPerSpan: 10},
			delivery: {
				mode: 'batched', batching: {maxBatch: 10},
				backpressure: {tokenBucketRate: 10, tokenBucketBurst: 10},
				circuitBreaker: {failureThreshold: 2, halfOpenAfterMs: 100},
				retry: {maxAttempts: 2, baseDelayMs: 1, multiplier: 2, maxDelayMs: 10, jitter: 0, attemptTimeoutMs: 10}
			}
		})
		expect(snapshotted).toMatchObject({
			resource: {attributes: {region: 'eu'}},
			limits: {maxAttributesPerSpan: 10},
			delivery: {batching: {maxBatch: 10}, retry: {maxAttempts: 2}}
		})
		expect(Object.isFrozen(snapshotted.resource)).toBe(true)
		expect(() => validateSamplingRatio(-1)).toThrow()
		expect(() => validateSamplingRatio(Number.NaN)).toThrow()
		expect(() => validateLimits({maxAttributesPerSpan: -1})).toThrow()
		expect(() => validateLimits({maxEventsPerSpan: -1})).toThrow()
		expect(() => validateLimits({maxAttrBytes: -1})).toThrow()
		expect(() => validateLimits({maxAttributesPerSpan: 10_001})).toThrow('10000')
		expect(() => validateLimits({maxEventsPerSpan: 10_001})).toThrow('10000')
		expect(() => validateLimits({maxAttrBytes: 10_000_001})).toThrow('10000000')
		const retry = {maxAttempts: 1, baseDelayMs: 2, multiplier: 2, maxDelayMs: 3, jitter: 0, attemptTimeoutMs: 0}
		expect(() => validateRetryPolicy({...retry, maxAttempts: 11})).toThrow('<= 10')
		expect(() => validateRetryPolicy({...retry, baseDelayMs: 2_147_483_648})).toThrow('2147483647')
		expect(() => validateRetryPolicy({...retry, multiplier: 0.5})).toThrow('>= 1')
		expect(() => validateRetryPolicy({...retry, maxDelayMs: 1})).toThrow('>= baseDelayMs')
		expect(() => validateRetryPolicy({...retry, maxDelayMs: 2_147_483_648})).toThrow('2147483647')
		expect(() => validateRetryPolicy({...retry, jitter: 2})).toThrow()
		expect(() => validateRetryPolicy({...retry, attemptTimeoutMs: 2_147_483_648})).toThrow('2147483647')
		expect(() => validateResilienceConfig({
			tokenBucketRate: -1, tokenBucketBurst: 1,
			breakerThreshold: 1, breakerHalfOpenTimeout: 1
		})).toThrow()
		expect(() => validateResilienceConfig({
			tokenBucketRate: 1, tokenBucketBurst: 0,
			breakerThreshold: 1, breakerHalfOpenTimeout: 1
		})).toThrow('positive integer')
		const resilience = {tokenBucketRate: 1, tokenBucketBurst: 1, breakerThreshold: 1, breakerHalfOpenTimeout: 1}
		expect(() => validateResilienceConfig({...resilience, tokenBucketRate: 1_000_001})).toThrow('1000000')
		expect(() => validateResilienceConfig({...resilience, tokenBucketBurst: 1_000_001})).toThrow('1000000')
		expect(() => validateResilienceConfig({...resilience, breakerThreshold: 10_001})).toThrow('10000')
		expect(() => validateResilienceConfig({...resilience, breakerHalfOpenTimeout: 2_147_483_648})).toThrow('2147483647')
		const tracerBase = {
			clock: {now: () => 0}, contextStore: {get: () => undefined, run: (_value: unknown, fn: () => unknown) => fn()},
			idGen: {nextTraceId: () => 'a'.repeat(32), nextSpanId: () => 'b'.repeat(16)},
			sampler: {decide: () => 'record-and-sample'}, processor: {onEnd: () => undefined, flush: async() => undefined, shutdown: async() => undefined}
		}
		expect(() => validateTracerOptions({...tracerBase, limits: {maxAttributesPerSpan: 1}} as never)).not.toThrow()
		expect(() => validateTracerOptions(undefined as never)).toThrow('clock')
		expect(() => validateTracerOptions({...tracerBase, contextStore: {}} as never)).toThrow('contextStore')
		expect(() => validateTracerOptions({...tracerBase, idGen: {}} as never)).toThrow('idGen')
		expect(() => validateTracerOptions({...tracerBase, sampler: {}} as never)).toThrow('sampler')
		expect(() => validateTracerOptions({...tracerBase, processor: {}} as never)).toThrow('processor')
	})

	it('covers telemetry and runtime optional dependency composition', async() => {
		const increment = vi.fn(); const record = vi.fn()
		const telemetry = new TelemetryManager({increment, record})
		telemetry.recordSpanProcessed(); telemetry.recordSpansExported(2); telemetry.recordExportFailure(); telemetry.recordSpansDropped()
		expect(increment).toHaveBeenCalled()
		expect(increment).toHaveBeenCalledWith('_traces_dropped_total', {reason: 'processor'}, 1)
		const processor = {onEnd: vi.fn(), flush: vi.fn(), shutdown: vi.fn(), setObserver: vi.fn()}
		const tracer = await createCustomTracingRuntime({
			clock: createFixedClock(0), sampler: createAlwaysOnSampler(), processor,
			metrics: {increment, record}, logger: {warn: vi.fn()} as never,
			resource: {serviceName: 'api'},
			limits: {maxAttributesPerSpan: 2, maxEventsPerSpan: 2, maxAttrBytes: 200}
		})
		await tracer.inSpan('runtime', async() => undefined)
		expect(processor.onEnd).toHaveBeenCalled()
		const metricsOnly = await createStandardTracingRuntime({
			clock: createFixedClock(0), sampler: createAlwaysOnSampler(), processor,
			metrics: {increment}, resource: {serviceName: 'detected'},
			limits: {maxAttributesPerSpan: 1, maxEventsPerSpan: 1, maxAttrBytes: 100}, preset: 'development'
		})
		await metricsOnly.inSpan('metrics-only', async() => undefined)
		const recordOnly = vi.fn()
		const recordOnlyRuntime = await createStandardTracingRuntime({
			clock: createFixedClock(0), sampler: createAlwaysOnSampler(), processor,
			metrics: {record: recordOnly},
			limits: {maxAttributesPerSpan: 1, maxEventsPerSpan: 1, maxAttrBytes: 100}, preset: 'development'
		})
		recordOnlyRuntime.startSpan('record-only').end()
		expect(recordOnly.mock.calls.some(([name]) => name === '_traces_span_duration_ms')).toBe(false)
		const minimal = await createStandardTracingRuntime({
			clock: createFixedClock(0), sampler: createAlwaysOnSampler(), processor,
			limits: {maxAttributesPerSpan: 1, maxEventsPerSpan: 1, maxAttrBytes: 100}, preset: 'development'
		})
		await minimal.inSpan('minimal', async() => undefined)
	})
})
