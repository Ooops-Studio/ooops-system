import {readFileSync} from 'node:fs'

import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {createContainer} from '@ooopsstudio/core/runtime/container'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {TOK} from '@ooopsstudio/core/tokens'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {registerTracing} from '../src'
import {createCustomTracing} from '../src/public/custom'
import {createDevelopmentTracing} from '../src/public/development'
import {createProductionTracing} from '../src/public/production'

const recordingExporter = () => {
	const records: SpanRecord[] = []
	return {
		records,
		exporter: {
			export: vi.fn(async(batch: readonly SpanRecord[]) => { records.push(...batch) }),
			shutdown: vi.fn(async() => undefined)
		}
	}
}

describe('tracing public simplification', () => {
	afterEach(() => vi.restoreAllMocks())

	it('uses async factories and the declarative custom destination', async() => {
		const {records, exporter} = recordingExporter()
		const pending = createCustomTracing({
			clock: createFixedClock(1),
			destination: {provider: 'custom', exporter}
		})
		expect(pending).toBeInstanceOf(Promise)
		const tracer = await pending
		await tracer.inSpan('custom', async() => undefined)
		await tracer.forceFlush()
		expect(records).toHaveLength(1)
		await tracer.shutdown()
	})

	it('fails closed for unknown or mixed custom tracing policy variants', async() => {
		const clock = createFixedClock(0)
		const exporter = {export: async() => undefined}
		await expect(createCustomTracing({
			clock,
			destination: {provider: 'unknown', endpoint: 'https://collector.example'}
		} as never)).rejects.toThrow('destination provider')
		await expect(createCustomTracing({
			clock,
			destination: {provider: 'custom', exporter, endpoint: 'https://collector.example'}
		} as never)).rejects.toThrow('only a custom exporter')
		await expect(createCustomTracing({
			clock,
			destination: {provider: 'custom', exporter},
			delivery: {mode: 'unknown'}
		} as never)).rejects.toThrow('delivery mode')
		await expect(createCustomTracing({
			clock,
			sampling: {strategy: 'unknown', rate: 1},
			destination: {provider: 'custom', exporter}
		} as never)).rejects.toThrow('sampling strategy')
		await expect(createCustomTracing({
			clock,
			destination: {provider: 'custom', exporter},
			delivery: {circuitBreaker: 'disabled'}
		} as never)).rejects.toThrow('circuitBreaker')
	})

	it('validates direct and batched configuration as immutable bootstrap policy', async() => {
		const {exporter} = recordingExporter()
		let coercions = 0
		const hostile = {[Symbol.toPrimitive]: () => { coercions++; return 1 }}
		await expect(createCustomTracing({
			clock: createFixedClock(0), destination: {provider: 'custom', exporter},
			delivery: {mode: 'batched', retry: {
				maxAttempts: hostile as never, baseDelayMs: 0, multiplier: 1,
				maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1
			}}
		})).rejects.toThrow('got: object')
		expect(coercions).toBe(0)
		await expect(createCustomTracing({
			clock: createFixedClock(0), destination: {provider: 'custom', exporter},
			delivery: {mode: 'direct', batching: {maxBatch: 1, maxIntervalMs: 1, maxBytes: 1}}
		})).rejects.toThrow('does not accept batching')
		await expect(createCustomTracing({
			clock: createFixedClock(0), destination: {provider: 'custom', exporter},
			delivery: {mode: 'direct', backpressure: {tokenBucketRate: 1, tokenBucketBurst: 1}}
		})).rejects.toThrow('does not accept')
		const batched = await createCustomTracing({
			clock: createFixedClock(0), destination: {provider: 'custom', exporter},
			delivery: {mode: 'batched'}
		})
		await batched.shutdown()
	})

	it('does not add hidden direct backpressure when only retry is configured', async() => {
		const exporter = {export: vi.fn(async() => undefined)}
		const tracer = await createCustomTracing({
			clock: createFixedClock(0),
			destination: {provider: 'custom', exporter},
			delivery: {mode: 'direct', retry: {
				maxAttempts: 2, baseDelayMs: 0, multiplier: 1,
				maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000
			}}
		})
		for (let index = 0; index < 101; index++) await tracer.inSpan(`direct-${index}`, async() => undefined)
		await tracer.forceFlush()
		expect(exporter.export).toHaveBeenCalledTimes(101)
		await tracer.shutdown()
	})

	it('represents a disabled circuit breaker by omitting the stage', () => {
		const source = readFileSync(new URL('../src/public/custom.ts', import.meta.url), 'utf8')
		expect(source).not.toMatch(/circuitBreaker === false \? 10_000/u)
		expect(source).not.toContain('2_147_483_647')
	})

	it('keeps mandatory redaction and clamps limits at the public boundary', async() => {
		const {records, exporter} = recordingExporter()
		const tracer = await createCustomTracing({
			clock: createFixedClock(0), destination: {provider: 'custom', exporter},
			limits: {maxAttributesPerSpan: 10_000, maxEventsPerSpan: 10_000, maxAttributeBytes: 100_000},
			redaction: {additionalRules: [{key: 'tenant', action: 'mask'}]}
		})
		await tracer.inSpan('safe', async(span) => {
			span.setAttribute('authorization', 'Bearer secret')
			span.setAttribute('tenant', 'acme')
		})
		await tracer.forceFlush()
		expect(records[0]?.attributes).toMatchObject({authorization: '***', tenant: '***'})
		await tracer.shutdown()
	})

	it('rejects accessor-backed configuration without executing accessors', async() => {
		let reads = 0
		const options = Object.defineProperty({}, 'clock', {
			enumerable: true, get: () => { reads++; return createFixedClock(0) }
		})
		await expect(createCustomTracing(options as never)).rejects.toThrow('closed plain data object')
		expect(reads).toBe(0)
	})

	it('closes an acquired custom exporter when runtime assembly fails before tracer creation', async() => {
		const exporter = {
			export: vi.fn(async() => undefined),
			shutdown: vi.fn(async() => undefined)
		}
		await expect(createCustomTracing({
			clock: createFixedClock(0),
			destination: {provider: 'custom', exporter},
			resource: {serviceName: 42}
		} as never)).rejects.toThrow('closed safe data object')
		expect(exporter.export).not.toHaveBeenCalled()
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('enforces strict production HTTPS remote validation', async() => {
		await expect(createProductionTracing({remote: {endpoint: 'x'.repeat(4_097)}}))
			.rejects.toThrow('1-4096')
		await expect(createProductionTracing({remote: {endpoint: 'http://collector.example.test/v1/traces'}}))
			.rejects.toThrow('HTTPS')
		await expect(createProductionTracing({remote: {endpoint: 'https://localhost/v1/traces'}}))
			.rejects.toThrow('public network')
		await expect(createProductionTracing({remote: {endpoint: 'https://169.254.169.254/v1/traces'}}))
			.rejects.toThrow('public network')
		await expect(createProductionTracing({remote: {endpoint: 'https://[::ffff:10.0.0.1]/v1/traces'}}))
			.rejects.toThrow('public network')
		const tracer = await createProductionTracing({
			remote: {endpoint: 'https://collector.example.test/v1/traces'},
			sampling: {strategy: 'fixed-rate', rate: 0.02},
			clock: createFixedClock(0)
		})
		expect(tracer.getStatus().state).toBe('running')
		await tracer.shutdown()
	})

	it('development remains console-only and fully sampled', async() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		const tracer = await createDevelopmentTracing({clock: createFixedClock(0)})
		await tracer.inSpan('development', async() => undefined)
		await tracer.forceFlush()
		expect(console.log).toHaveBeenCalled()
		await tracer.shutdown()
	})

	it('registers asynchronously and binds the resolved managed tracer', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(0))
		const {exporter} = recordingExporter()
		await registerTracing(container, {
			preset: 'custom',
			options: {destination: {provider: 'custom', exporter}}
		})
		const tracer = container.get(TOK.Tracing) as Awaited<ReturnType<typeof createCustomTracing>>
		expect(tracer.getStatus().state).toBe('running')
		await expect(registerTracing(container, {
			preset: 'custom', options: {destination: {provider: 'custom', exporter}}
		})).rejects.toThrow('already registered')
		await tracer.shutdown()
	})

	it('snapshots configuration before re-entrant container callbacks can mutate it', async() => {
		const original = recordingExporter()
		const redirected = recordingExporter()
		const options = {
			preset: 'custom' as const,
			options: {destination: {provider: 'custom' as const, exporter: original.exporter}}
		}
		const bindings = new Map<symbol, unknown>([[TOK.Clock, createFixedClock(0)]])
		let firstTracingLookup = true
		const container = {
			has: (token: symbol) => {
				if (token === TOK.Tracing && firstTracingLookup) {
					firstTracingLookup = false
					options.options.destination.exporter = redirected.exporter
				}
				return bindings.has(token)
			},
			get: (token: symbol) => bindings.get(token),
			tryGet: (token: symbol) => bindings.get(token),
			bind: (token: symbol, value: unknown) => { bindings.set(token, value) },
			unbind: (token: symbol) => bindings.delete(token)
		}

		await registerTracing(container as never, options)
		const tracer = bindings.get(TOK.Tracing) as Awaited<ReturnType<typeof createCustomTracing>>
		await tracer.inSpan('snapshotted', async() => undefined)
		await tracer.forceFlush()
		expect(original.exporter.export).toHaveBeenCalledOnce()
		expect(redirected.exporter.export).not.toHaveBeenCalled()
		await tracer.shutdown()
	})

	it('captures the clock and optional lifecycle methods once at bootstrap', async() => {
		const clock = {now: () => 1}
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
		const poisonedFlush = vi.fn(() => { throw new Error('late lifecycle rewiring') })
		const lifecycle = {
			registerShutdownHook: vi.fn(() => {
				lifecycle.registerFlushHook = poisonedFlush
				return disposeShutdown
			}),
			registerFlushHook: vi.fn(() => disposeFlush)
		}
		const originalFlush = lifecycle.registerFlushHook
		const bindings = new Map<symbol, unknown>([
			[TOK.Clock, clock],
			[TOK.Lifecycle, lifecycle]
		])
		const container = {
			has: (token: symbol) => bindings.has(token),
			get: (token: symbol) => bindings.get(token),
			tryGet: (token: symbol) => {
				if (token === TOK.Logging) clock.now = () => { throw new Error('late clock rewiring') }
				return bindings.get(token)
			},
			bind: (token: symbol, value: unknown) => { bindings.set(token, value) },
			unbind: (token: symbol) => bindings.delete(token)
		}
		const {exporter} = recordingExporter()

		await registerTracing(container as never, {
			preset: 'custom',
			options: {destination: {provider: 'custom', exporter}}
		})
		expect(originalFlush).toHaveBeenCalledOnce()
		expect(poisonedFlush).not.toHaveBeenCalled()
		const tracer = bindings.get(TOK.Tracing) as Awaited<ReturnType<typeof createCustomTracing>>
		await expect(tracer.inSpan('captured-clock', async() => undefined)).resolves.toBeUndefined()
		await tracer.shutdown()
	})

	it('awaits shutdown and removes a partial binding during registration rollback', async() => {
		const bindings = new Map<symbol, unknown>([[TOK.Clock, createFixedClock(0)]])
		let closed = false
		const container = {
			has: (token: symbol) => bindings.has(token),
			get: (token: symbol) => bindings.get(token),
			tryGet: (token: symbol) => bindings.get(token),
			unbind: (token: symbol) => bindings.delete(token),
			bind: (token: symbol, value: unknown) => {
				bindings.set(token, value)
				if (token === TOK.Tracing) throw new Error('bind failed')
			}
		}
		await expect(registerTracing(container as never, {
			preset: 'custom', options: {destination: {provider: 'custom', exporter: {
				export: async() => undefined,
				shutdown: async() => { closed = true }
			}}}
		})).rejects.toThrow('bind failed')
		expect(bindings.has(TOK.Tracing)).toBe(false)
		expect(closed).toBe(true)
	})

	it('preserves a foreign binding installed by a re-entrant failed bind', async() => {
		const foreign = {kind: 'foreign'}
		const bindings = new Map<symbol, unknown>([[TOK.Clock, createFixedClock(0)]])
		const exporter = {
			export: vi.fn(async() => undefined),
			shutdown: vi.fn(async() => undefined)
		}
		const container = {
			has: (token: symbol) => bindings.has(token),
			get: (token: symbol) => bindings.get(token),
			tryGet: (token: symbol) => bindings.get(token),
			unbind: (token: symbol) => bindings.delete(token),
			bind: (token: symbol, value: unknown) => {
				if (token !== TOK.Tracing) {
					bindings.set(token, value)
					return
				}
				bindings.set(token, foreign)
				throw new Error('re-entrant bind failed')
			}
		}

		await expect(registerTracing(container as never, {
			preset: 'custom',
			options: {destination: {provider: 'custom', exporter}}
		})).rejects.toThrow('re-entrant bind failed')
		expect(bindings.get(TOK.Tracing)).toBe(foreign)
		expect(exporter.shutdown).toHaveBeenCalledOnce()
	})

	it('rejects removed legacy registration shapes', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(0))
		await expect(registerTracing(container, {preset: 'invalid'} as never)).rejects.toThrow('Unknown tracing preset')
		await expect(registerTracing(container, {
			preset: 'custom', options: {sampler: {}, exporter: {}} as never
		})).rejects.toThrow('unexpected fields')
		expect(container.has(TOK.Tracing)).toBe(false)
	})
})
