import {TOK, createContainer} from '@ooopsstudio/core'
import type {Container} from '@ooopsstudio/core/runtime'
import {describe, expect, it, vi} from 'vitest'

import {createErrorHandler} from '../src/core/create-error-handler'
import {createReportRuntime} from '../src/core/report'
import {ErrorsFinalizationTimeoutError, isErrorsTimeout, withErrorsTimeout} from '../src/core/timeout'
import {reportAll} from '../src/features/reporters/report-all'
import {reportToTrace} from '../src/features/reporters/trace-reporter'
import {registerErrors} from '../src/index-registration'
import {createCustomErrorHandler} from '../src/public/custom'
import {createDevelopmentErrorHandler} from '../src/public/development'
import {createProductionErrorHandler} from '../src/public/production'
import {createSentryErrorSink} from '../src/sentry'
import {createSentryEvent} from '../src/sinks/providers/sentry-event'
import {
	sanitizeSentryExtra,
	sanitizeSentryString,
	sanitizeSentryTags,
	sanitizeSentryTagValue,
	sentryStackFrames
} from '../src/sinks/providers/sentry-sanitization'
import type {EnrichedError} from '../src/types/normalized-error'
import {
	redactEnrichedError,
	redactErrorValue,
	sanitizeErrorDiagnostic,
	sanitizeErrorDiagnosticId
} from '../src/utils/redaction'

import {createFixedClock} from './fixed-clock'

const error: EnrichedError = {
	kind: 'Error', message: 'boom', severity: 'error', category: 'UNKNOWN', timestamp: 1
}

describe('errors runtime safety regressions', () => {
	it('classifies finalization timeouts without trusting hostile rejection values', () => {
		expect(isErrorsTimeout(new ErrorsFinalizationTimeoutError('shutdown', 1), 'shutdown')).toBe(true)
		expect(isErrorsTimeout(new ErrorsFinalizationTimeoutError('flush', 1), 'shutdown')).toBe(false)
		const hostile = new Proxy({}, {
			getPrototypeOf: () => { throw new Error('prototype blocked') }
		})
		expect(() => isErrorsTimeout(hostile, 'shutdown')).not.toThrow()
		expect(isErrorsTimeout(hostile, 'shutdown')).toBe(false)
	})

	it('does not let timer cleanup failures replace a successful operation', async() => {
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
			throw new Error('hostile timer cleanup')
		})
		try {
			await expect(withErrorsTimeout(Promise.resolve('ok'), 10, 'flush')).resolves.toBe('ok')
		} finally {
			clearTimeoutSpy.mockRestore()
		}
	})

	it('finishes an accepted report-runtime flush before closing its sink', async() => {
		const gate = Promise.withResolvers<void>()
		let closed = false
		let flushCalls = 0
		const sink = {
			capture: vi.fn(async() => {}),
			flush: vi.fn(async() => {
				flushCalls++
				if (flushCalls === 1) await gate.promise
				if (closed) throw new Error('flush reached a closed sink')
			}),
			close: vi.fn(async() => { closed = true })
		}
		const runtime = createReportRuntime({sink})

		const flushing = runtime.flush()
		await vi.waitFor(() => expect(sink.flush).toHaveBeenCalledOnce())
		const stopping = runtime.shutdown()
		for (let index = 0; index < 5; index++) await Promise.resolve()
		expect(sink.flush).toHaveBeenCalledOnce()
		expect(sink.close).not.toHaveBeenCalled()
		gate.resolve()
		await expect(Promise.all([flushing, stopping])).resolves.toEqual([undefined, undefined])
		expect(sink.close).toHaveBeenCalledOnce()
	})

	it('drains direct report-runtime work before flushing and closing the sink', async() => {
		const gate = Promise.withResolvers<void>()
		const sink = {
			capture: vi.fn(async() => {}), flush: vi.fn(async() => {}), close: vi.fn(async() => {})
		}
		const runtime = createReportRuntime({
			baseReport: vi.fn(async() => { await gate.promise }), sink
		})
		const reporting = runtime.report(error)
		await Promise.resolve()
		const shutdown = runtime.shutdown()
		await Promise.resolve()
		expect(sink.flush).not.toHaveBeenCalled()
		gate.resolve()
		await Promise.all([reporting, shutdown])
		expect(sink.capture).toHaveBeenCalledTimes(1)
		expect(sink.flush).toHaveBeenCalledTimes(1)
		expect(sink.close).toHaveBeenCalledTimes(1)
	})

	it('starts built-in delivery without waiting for a custom reporter', async() => {
		const gate = Promise.withResolvers<void>()
		const capture = vi.fn(async() => {})
		const runtime = createReportRuntime({
			baseReport: vi.fn(async() => { await gate.promise }),
			sink: {capture}
		})

		const reporting = runtime.report(error)
		await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
		gate.resolve()
		await reporting
		await runtime.shutdown()
	})

	it('isolates observer payloads from reporter and sink mutation', async() => {
		const observations: Array<{event: string; data: unknown}> = []
		const sink = {
			capture: vi.fn(async(captured: EnrichedError) => {
				;(captured as {message: string}).message = 'token=secret-injected-by-sink'
				;(captured as {context?: Record<string, unknown>}).context = {password: 'sink-secret'}
			})
		}
		await reportAll(error, {
			sink,
			observe: (event, data) => { observations.push({event, data}) }
		})

		const serialized = JSON.stringify(observations)
		expect(serialized).not.toContain('secret-injected-by-sink')
		expect(serialized).not.toContain('sink-secret')
	})

	it('isolates built-in delivery from custom base-reporter mutation', async() => {
		const capture = vi.fn(async() => {})
		const runtime = createReportRuntime({
			baseReport: async(reported) => {
				;(reported as {message: string}).message = 'changed-by-custom-reporter'
			},
			sink: {capture}
		})

		await runtime.report(error)
		expect(capture).toHaveBeenCalledWith(expect.objectContaining({message: 'boom'}))
		await runtime.shutdown()
	})

	it('isolates missing methods on a malformed partial logger', async() => {
		const observe = vi.fn()
		const logger = {error: vi.fn()} as Record<string, unknown>
		const infoGetter = vi.fn(() => { throw new Error('logger token=must-not-escape') })
		Object.defineProperty(logger, 'info', {get: infoGetter})
		const runtime = createReportRuntime({
			logger: logger as never,
			observe
		})

		await expect(runtime.report({...error, severity: 'info'})).resolves.toBeUndefined()
		expect(observe).toHaveBeenCalledWith('error:reporter', expect.objectContaining({
			reporter: 'log', status: 'error'
		}))
		expect(infoGetter).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('coalesces concurrent direct report-runtime flushes', async() => {
		const gate = Promise.withResolvers<void>()
		const flush = vi.fn(async() => { await gate.promise })
		const runtime = createReportRuntime({sink: {capture: vi.fn(async() => {}), flush}})

		const first = runtime.flush()
		const second = runtime.flush()
		await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
		gate.resolve()
		await Promise.all([first, second])
		expect(flush).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('bounds pending report-runtime flush callers around one physical flush', async() => {
		const gate = Promise.withResolvers<void>()
		const flush = vi.fn(async() => { await gate.promise })
		const runtime = createReportRuntime({sink: {capture: vi.fn(async() => {}), flush}})

		const pending = Array.from({length: 64}, () => runtime.flush())
		await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
		await expect(runtime.flush()).rejects.toThrow('pending flush capacity exceeded')
		gate.resolve()
		await expect(Promise.all(pending)).resolves.toHaveLength(64)
		expect(flush).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('settles an earlier report-runtime flush without chasing a later generation', async() => {
		const firstGate = Promise.withResolvers<void>()
		const secondGate = Promise.withResolvers<void>()
		const flush = vi.fn(async() => {
			if (flush.mock.calls.length === 1) await firstGate.promise
			else await secondGate.promise
		})
		const runtime = createReportRuntime({sink: {capture: vi.fn(async() => {}), flush}})

		const first = runtime.flush()
		await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
		await runtime.report(error)
		const second = runtime.flush()
		firstGate.resolve()
		await expect(first).resolves.toBeUndefined()
		await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2))
		let secondSettled = false
		void second.then(() => { secondSettled = true })
		await Promise.resolve()
		expect(secondSettled).toBe(false)
		secondGate.resolve()
		await second
		await runtime.shutdown()
	})

	it('bounds concurrent report-runtime finalization callers', async() => {
		const closeGate = Promise.withResolvers<void>()
		const close = vi.fn(async() => { await closeGate.promise })
		const runtime = createReportRuntime({sink: {capture: vi.fn(async() => {}), close}})

		const pending = Array.from({length: 64}, () => runtime.shutdown())
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
		await expect(runtime.shutdown()).rejects.toThrow('pending finalization capacity exceeded')
		closeGate.resolve()
		await expect(Promise.all(pending)).resolves.toHaveLength(64)
		await runtime.shutdown()
	})

	it('extends a coalesced report-runtime flush for work accepted before a later caller', async() => {
		const firstFlush = Promise.withResolvers<void>()
		let flushCalls = 0
		const flush = vi.fn(async() => {
			flushCalls++
			if (flushCalls === 1) await firstFlush.promise
		})
		const capture = vi.fn(async() => {})
		const runtime = createReportRuntime({sink: {capture, flush}})

		const first = runtime.flush()
		await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
		await runtime.report(error)
		const second = runtime.flush()
		firstFlush.resolve()
		await Promise.all([first, second])
		expect(capture).toHaveBeenCalledOnce()
		expect(flush).toHaveBeenCalledTimes(2)
		await runtime.shutdown()
	})

	it('snapshots external deduplication cache port methods', async() => {
		const originalGet = vi.fn(function(this: {marker: string}) {
			expect(this.marker).toBe('cache-port')
			return undefined
		})
		const originalSet = vi.fn(function(this: {marker: string}) {
			expect(this.marker).toBe('cache-port')
		})
		const cache = {marker: 'cache-port', get: originalGet, set: originalSet}
		const report = vi.fn(async() => {})
		const handler = createErrorHandler({
			clock: createFixedClock(1), deduplicate: true, report, ports: {cache}
		})
		const replacement = vi.fn()
		cache.get = replacement
		cache.set = replacement

		await handler.handle(new Error('stable cache port'))

		expect(originalGet).toHaveBeenCalledOnce()
		expect(originalSet).toHaveBeenCalledOnce()
		expect(report).toHaveBeenCalledOnce()
		expect(replacement).not.toHaveBeenCalled()
		await handler.shutdown()

		const hostileCache = Object.create(null) as Record<string, unknown>
		Object.defineProperty(hostileCache, 'get', {
			get: () => { throw new Error('cache token=must-not-escape') }
		})
		const fallbackReport = vi.fn(async() => {})
		const fallback = createErrorHandler({
			clock: createFixedClock(1), deduplicate: true, report: fallbackReport,
			ports: {cache: hostileCache as never}
		})
		await fallback.handle(new Error('still visible'))
		expect(fallbackReport).toHaveBeenCalledOnce()
		await fallback.shutdown()

		const stringify = vi.fn(() => '{"timestamp":1}')
		const malformedReport = vi.fn(async() => {})
		const malformed = createErrorHandler({
			clock: createFixedClock(1), deduplicate: true, report: malformedReport,
			ports: {cache: {get: vi.fn(async() => ({toString: stringify}))} as never}
		})
		await malformed.handle(new Error('malformed cache value'))
		expect(malformedReport).toHaveBeenCalledOnce()
		expect(stringify).not.toHaveBeenCalled()
		await malformed.shutdown()
	})

	it('uses the exact classification registry snapshot accepted by validation', async() => {
		let patternReads = 0
		const patterns = new Proxy(['TokenBucketExhaustedError'], {
			getOwnPropertyDescriptor(target, key) {
				if (key === '0') {
					patternReads++
					return {
						value: patternReads === 1 ? 'TokenBucketExhaustedError' : 'ChangedAfterValidationError',
						enumerable: true, configurable: true, writable: true
					}
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		const handler = createErrorHandler({
			clock: createFixedClock(1),
			classificationRegistry: {RATE_LIMIT: patterns}
		})

		await expect(handler.handle({kind: 'TokenBucketExhaustedError', message: 'limited'}))
			.resolves.toMatchObject({category: 'RATE_LIMIT'})
		expect(patternReads).toBe(1)
		await handler.shutdown()
	})

	it('rejects unknown and duplicate registration without touching dependencies', async() => {
		const get = vi.fn(() => { throw new Error('dependency access forbidden') })
		const fake = {
			has: vi.fn(() => false), get, tryGet: vi.fn(), bind: vi.fn(), unbind: vi.fn(() => false)
		} as unknown as Container
		await expect(registerErrors(fake, {preset: 'minimal'} as never)).rejects.toThrow('Unknown errors preset')
		const invalidPreset = await registerErrors(fake, {preset: 'token=registration-secret'} as never)
			.catch((error: unknown) => error)
		expect(invalidPreset).toMatchObject({message: 'Unknown errors preset: invalid'})
		expect((invalidPreset as Error).message).not.toContain('registration-secret')
		expect(get).not.toHaveBeenCalled()
		const hostilePreset = {toString: vi.fn(() => { throw new Error('must not execute') })}
		await expect(registerErrors(fake, {preset: hostilePreset} as never)).rejects.toThrow('Unknown errors preset: invalid')
		expect(hostilePreset.toString).not.toHaveBeenCalled()
		await expect(registerErrors(fake, {preset: 'custom', options: null} as never)).rejects.toThrow('errors_invalid_options')
		expect(get).not.toHaveBeenCalled()

		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		await registerErrors(container, {preset: 'custom'})
		await expect(registerErrors(container, {preset: 'custom'})).rejects.toThrow('errors_already_registered')
	})

	it('does not execute registration accessors and validates the container boundary', async() => {
		const presetGetter = vi.fn(() => 'production')
		const configuration = {} as {preset: 'production'}
		Object.defineProperty(configuration, 'preset', {enumerable: true, get: presetGetter})
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		await expect(registerErrors(container, configuration)).rejects.toThrow('Unknown errors preset')
		expect(presetGetter).not.toHaveBeenCalled()
		const optionsGetter = vi.fn(() => ({sink: {capture: vi.fn()}}))
		const accessorOptions = {preset: 'production'} as {preset: 'production'; options?: unknown}
		Object.defineProperty(accessorOptions, 'options', {enumerable: true, get: optionsGetter})
		await expect(registerErrors(container, accessorOptions as never)).rejects.toThrow('Unknown errors preset')
		expect(optionsGetter).not.toHaveBeenCalled()
		await expect(registerErrors(container, {
			preset: 'production', option: {sink: {capture: vi.fn()}}
		} as never)).rejects.toThrow('Unknown errors preset')
		await expect(registerErrors(null as never, {preset: 'custom'})).rejects.toThrow('errors_invalid_container')
		await expect(registerErrors({
			has: vi.fn(() => false), get: vi.fn(), tryGet: vi.fn()
		} as never, {preset: 'custom'})).rejects.toThrow('errors_invalid_container')
		const missingClockContainer = {
			has: vi.fn(() => false), get: vi.fn(() => undefined), tryGet: vi.fn(() => undefined),
			bind: vi.fn(), unbind: vi.fn(() => false)
		} as unknown as Container
		await expect(registerErrors(missingClockContainer, {preset: 'custom'}))
			.rejects.toThrow('errors_invalid_clock')
		expect(missingClockContainer.bind).not.toHaveBeenCalled()

		const containerWithoutUnbind = {
			has: vi.fn(() => false),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn(() => undefined),
			bind: vi.fn()
		}
		await expect(registerErrors(containerWithoutUnbind as never, {preset: 'custom'}))
			.rejects.toThrow('errors_invalid_container')
		expect(containerWithoutUnbind.get).not.toHaveBeenCalled()
		expect(containerWithoutUnbind.bind).not.toHaveBeenCalled()
		const hostileContainer = Object.create(null) as Record<string, unknown>
		const hasGetter = vi.fn(() => { throw new Error('container token=must-not-escape') })
		Object.defineProperty(hostileContainer, 'has', {get: hasGetter})
		await expect(registerErrors(hostileContainer as never, {preset: 'custom'}))
			.rejects.toMatchObject({message: 'errors_invalid_container'})
		expect(hasGetter).not.toHaveBeenCalled()
		await expect(createDevelopmentErrorHandler(null as never)).rejects.toThrow('errors_invalid_options')
		await expect(createProductionErrorHandler(null as never)).rejects.toThrow('errors_invalid_options')
		await expect(createDevelopmentErrorHandler({clock: null} as never)).rejects.toThrow('errors_invalid_clock')
		await expect(createProductionErrorHandler({clock: null} as never)).rejects.toThrow('errors_invalid_clock')
		await expect(createProductionErrorHandler({sink: null} as never)).rejects.toThrow('errors_invalid_sink')
		await expect(createProductionErrorHandler({rethrow: true} as never)).rejects.toThrow('errors_invalid_options')
		const invalidClockContainer = createContainer()
		invalidClockContainer.bind(TOK.Clock, createFixedClock(1))
		await expect(registerErrors(invalidClockContainer, {
			preset: 'custom', options: {clock: null} as never
		})).rejects.toThrow('errors_invalid_clock')
		expect(invalidClockContainer.has(TOK.Errors)).toBe(false)
		expect(() => createErrorHandler({unknownOption: true} as never)).toThrow('errors_invalid_options')
		expect(() => createErrorHandler({ports: {unknownPort: {}}} as never)).toThrow('errors_invalid_ports')

		const nestedGetter = vi.fn(() => createFixedClock(99))
		const developmentOptions = {} as {clock?: ReturnType<typeof createFixedClock>}
		Object.defineProperty(developmentOptions, 'clock', {enumerable: true, get: nestedGetter})
		await expect(createDevelopmentErrorHandler(developmentOptions)).rejects.toThrow('errors_invalid_options')
		expect(nestedGetter).not.toHaveBeenCalled()

		const portsGetter = vi.fn(() => ({logger: {}}))
		const customOptions = {} as Record<string, unknown>
		Object.defineProperty(customOptions, 'ports', {enumerable: true, get: portsGetter})
		const accessorContainer = createContainer()
		accessorContainer.bind(TOK.Clock, createFixedClock(1))
		await expect(registerErrors(accessorContainer, {preset: 'custom', options: customOptions as never}))
			.rejects.toThrow('errors_invalid_options')
		expect(portsGetter).not.toHaveBeenCalled()

		await expect(createDevelopmentErrorHandler(new Proxy({}, {
			getOwnPropertyDescriptor() { throw new Error('raw proxy failure') }
		}) as never)).rejects.toMatchObject({message: 'errors_invalid_options'})

		const inheritedOptions = Object.create({clock: null}) as Record<string, unknown>
		await expect(createCustomErrorHandler(inheritedOptions as never)).rejects.toThrow('errors_invalid_options')
		const inheritedPorts = Object.create({logger: {error: vi.fn()}}) as Record<string, unknown>
		await expect(createCustomErrorHandler({ports: inheritedPorts as never})).rejects.toThrow('errors_invalid_ports')
		const inheritedRegistration = Object.create({options: {clock: null}}) as Record<string, unknown>
		inheritedRegistration.preset = 'custom'
		await expect(registerErrors(container, inheritedRegistration as never)).rejects.toThrow('Unknown errors preset')
	})

	it('destroys a constructed handler when container binding fails', async() => {
		const disposeFlush = vi.fn()
		const disposeShutdown = vi.fn()
		const lifecycle = {
			registerFlushHook: vi.fn(() => disposeFlush),
			registerShutdownHook: vi.fn(() => disposeShutdown)
		}
		let bound: unknown
		const fake = {
			has: vi.fn((token) => token === TOK.Errors && bound !== undefined),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token) => token === TOK.Lifecycle ? lifecycle : token === TOK.Errors ? bound : undefined),
			bind: vi.fn((_token, value) => { bound = value; throw new Error('bind failed') }),
			unbind: vi.fn((token) => {
				if (token !== TOK.Errors || bound === undefined) return false
				bound = undefined
				return true
			})
		} as unknown as Container
		await expect(registerErrors(fake, {preset: 'custom'})).rejects.toThrow('errors_registration_failed')
		expect(fake.unbind).toHaveBeenCalledWith(TOK.Errors)
		expect(bound).toBeUndefined()
		expect(disposeFlush).toHaveBeenCalledTimes(1)
		expect(disposeShutdown).toHaveBeenCalledTimes(1)
	})

	it('destroys constructed handlers when the final registration check or bind retention fails', async() => {
		const createLifecycle = () => {
			const disposeFlush = vi.fn()
			const disposeShutdown = vi.fn()
			return {
				lifecycle: {
					registerFlushHook: vi.fn(() => disposeFlush),
					registerShutdownHook: vi.fn(() => disposeShutdown)
				},
				disposeFlush,
				disposeShutdown
			}
		}

		const failedCheck = createLifecycle()
		let checks = 0
		const throwingCheckContainer = {
			has: vi.fn(() => {
				checks++
				if (checks === 2) throw new Error('post-construction check failed')
				return false
			}),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token) => token === TOK.Lifecycle ? failedCheck.lifecycle : undefined),
			bind: vi.fn(),
			unbind: vi.fn(() => false)
		} as unknown as Container
		await expect(registerErrors(throwingCheckContainer, {preset: 'custom'}))
			.rejects.toThrow('errors_registration_failed')
		expect(failedCheck.disposeFlush).toHaveBeenCalledOnce()
		expect(failedCheck.disposeShutdown).toHaveBeenCalledOnce()

		const ignoredBind = createLifecycle()
		const noOpContainer = {
			has: vi.fn(() => false),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token) => token === TOK.Lifecycle ? ignoredBind.lifecycle : undefined),
			bind: vi.fn(),
			unbind: vi.fn(() => false)
		} as unknown as Container
		await expect(registerErrors(noOpContainer, {preset: 'custom'}))
			.rejects.toThrow('errors_registration_not_retained')
		expect(ignoredBind.disposeFlush).toHaveBeenCalledOnce()
		expect(ignoredBind.disposeShutdown).toHaveBeenCalledOnce()
	})

	it('restores the unbound state when a failed container bind substitutes a foreign value', async() => {
		let bound: unknown
		const container = {
			has: vi.fn((token) => token === TOK.Errors && bound !== undefined),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token) => token === TOK.Errors ? bound : undefined),
			bind: vi.fn((_token, _value) => { bound = {foreign: true} }),
			unbind: vi.fn((token) => {
				if (token !== TOK.Errors || bound === undefined) return false
				bound = undefined
				return true
			})
		} as unknown as Container

		await expect(registerErrors(container, {preset: 'custom'}))
			.rejects.toThrow('errors_registration_not_retained')
		expect(container.unbind).toHaveBeenCalledWith(TOK.Errors)
		expect(bound).toBeUndefined()
	})

	it('attempts rollback even when post-bind container inspection throws', async() => {
		let bound: unknown
		let failInspection = false
		const container = {
			has: vi.fn((token) => {
				if (failInspection) throw new Error('post-bind inspection failed')
				return token === TOK.Errors && bound !== undefined
			}),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token) => token === TOK.Errors ? bound : undefined),
			bind: vi.fn((_token, value) => {
				bound = value
				failInspection = true
			}),
			unbind: vi.fn((token) => {
				if (token !== TOK.Errors || bound === undefined) return false
				bound = undefined
				failInspection = false
				return true
			})
		} as unknown as Container

		await expect(registerErrors(container, {preset: 'custom'}))
			.rejects.toThrow('errors_registration_failed')
		expect(container.unbind).toHaveBeenCalledWith(TOK.Errors)
		expect(bound).toBeUndefined()
	})

	it('rejects and rolls back a retained binding when container has() remains false', async() => {
		let bound: unknown
		const container = {
			has: vi.fn(() => false),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token) => token === TOK.Errors ? bound : undefined),
			bind: vi.fn((_token, value) => { bound = value }),
			unbind: vi.fn((token) => {
				if (token !== TOK.Errors || bound === undefined) return false
				bound = undefined
				return true
			})
		} as unknown as Container

		await expect(registerErrors(container, {preset: 'custom'}))
			.rejects.toThrow('errors_registration_not_retained')
		expect(container.unbind).toHaveBeenCalledWith(TOK.Errors)
		expect(bound).toBeUndefined()
	})

	it('does not overwrite or remove a binding installed during async preset construction', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		const registering = registerErrors(container, {preset: 'development'})
		const concurrent = {report: vi.fn()}
		container.bind(TOK.Errors, concurrent)

		await expect(registering).rejects.toThrow('errors_already_registered')
		expect(container.get(TOK.Errors)).toBe(concurrent)
	})

	it('bounds Sentry timeouts, forbids redirects, and skips hostile or sensitive tags', async() => {
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 1.5
		})).toThrow('requestTimeoutMs')
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 60_001
		})).toThrow('requestTimeoutMs')
		const hiddenConfig = {dsn: 'https://public@example.ingest.sentry.io/42'}
		Object.defineProperty(hiddenConfig, 'requestTimeoutMs', {value: 5, enumerable: false})
		expect(() => createSentryErrorSink(hiddenConfig)).toThrow('invalid configuration')
		const inheritedConfig = Object.create({dsn: 'https://public@example.ingest.sentry.io/42'})
		expect(() => createSentryErrorSink(inheritedConfig)).toThrow('invalid configuration')
		const inheritedTags = Object.create({safe: 'value'})
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', tags: inheritedTags
		})).toThrow('plain object')

		const getter = vi.fn(() => 'must-not-run')
		const tags: Record<string, string> = {
			authorization: 'short-secret', awsAccessKey: 'also-short', safe: 'ok'
		}
		Object.defineProperty(tags, 'hostile', {enumerable: true, get: getter})
		const fetch = vi.fn().mockResolvedValue({ok: true, status: 200})
		vi.stubGlobal('fetch', fetch)
		try {
			const sink = createSentryErrorSink({
				dsn: 'https://public@example.ingest.sentry.io/42', tags
			})
			tags.safe = 'mutated-after-construction'
			tags.late = 'must-not-appear'
			await sink.capture(error)
			const request = fetch.mock.calls[0]?.[1] as {redirect?: string; body?: unknown}
			expect(request.redirect).toBe('error')
			expect(getter).not.toHaveBeenCalled()
			const event = JSON.parse(String(request.body).split('\n')[2]!) as {tags: Record<string, string>}
			expect(event.tags).not.toHaveProperty('authorization')
			expect(event.tags).not.toHaveProperty('awsAccessKey')
			expect(event.tags.safe).toBe('ok')
			expect(event.tags).not.toHaveProperty('late')
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('does not permit prototype keys or raw current trace identifiers through diagnostics', async() => {
		const input = Object.create(null) as Record<string, unknown>
		Object.defineProperty(input, '__proto__', {value: {polluted: true}, enumerable: true})
		input.safe = 'value'
		const redacted = redactErrorValue(input) as Record<string, unknown>
		expect(Object.getPrototypeOf(redacted)).toBeNull()
		expect(redacted).not.toHaveProperty('__proto__')

		const recordException = vi.fn()
		await reportToTrace(error, {
			currentTraceId: () => 'token=trace-secret', recordException
		} as never)
		const context = recordException.mock.calls[0]?.[1] as {traceId?: string}
		expect(context.traceId).not.toContain('trace-secret')
	})

	it('fingerprints tenant-like kinds and codes at the shared reporting boundary', () => {
		const redacted = redactEnrichedError({
			kind: 'TenantAcmeFailure', code: 'WORKSPACE_ALPHA', message: 'safe',
			severity: 'error', category: 'UNKNOWN', timestamp: 1
		})
		expect(redacted.kind).toMatch(/^kind:hash:/u)
		expect(redacted.code).toMatch(/^code:hash:/u)
		expect(JSON.stringify(redacted)).not.toMatch(/acme|workspace_alpha/iu)
	})

	it('redacts common standalone credential formats without requiring assignments', () => {
		const secrets = [
			'AKIA1234567890ABCDEF',
			'ghp_123456789012345678901234567890123456',
			'sk_live_12345678901234567890',
			'eyJabcde12345.abcdef12345.signature12345',
			'-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----'
		]
		for (const secret of secrets) {
			const sanitized = String(redactErrorValue(`failure ${secret}`))
			expect(sanitized).not.toContain(secret)
			expect(sanitized).toContain('[REDACTED]')
		}
	})

	it('redacts modern UUIDs and scheme-less query URLs in every diagnostic projection', () => {
		const uuidV7 = '01890f3e-7b2a-7cc1-8f6d-4f7d2b15c901'
		const bareUrl = 'tenant.example.com/search?q=private-term&workspace=acme'
		const redacted = redactErrorValue(`request ${uuidV7} failed at ${bareUrl} or search?q=second-private-term`)
		expect(redacted).not.toContain(uuidV7)
		expect(redacted).not.toContain('private-term')
		expect(redacted).not.toContain('second-private-term')
		expect(sanitizeSentryTagValue('request_id', uuidV7)).toMatch(/^id:[a-z0-9]+$/u)
	})

	it('fingerprints tenant/workspace identifiers in values and metadata keys', () => {
		const redacted = redactErrorValue({
			tenantId: 'tenant-acme',
			workspaceId: 'workspace-alpha',
			tenant_acme: 'present'
		}) as Record<string, unknown>
		const serialized = JSON.stringify(redacted)
		expect(serialized).not.toContain('tenant-acme')
		expect(serialized).not.toContain('workspace-alpha')
		expect(serialized).not.toContain('tenant_acme')
		const sentry = JSON.stringify(sanitizeSentryExtra({tenantId: 'tenant-acme', tenant_acme: 'present'}))
		expect(sentry).not.toContain('tenant-acme')
		expect(sentry).not.toContain('tenant_acme')
	})

	it('redacts compound and abbreviated credential assignments in free-form text', () => {
		const value = redactErrorValue(
			'aws_secret_access_key=alpha dbPassword="bravo" pwd:charlie serviceToken=delta Authorization:echo Cookie=foxtrot'
		) as string
		expect(value).not.toContain('alpha')
		expect(value).not.toContain('bravo')
		expect(value).not.toContain('charlie')
		expect(value).not.toContain('delta')
		expect(value).not.toContain('echo')
		expect(value).not.toContain('foxtrot')
		// Authorization/Cookie headers are fail-closed as one complete line value,
		// so the trailing Cookie assignment is intentionally covered by the same mask.
		expect(value.match(/\[REDACTED\]/gu)).toHaveLength(5)
		expect(sanitizeSentryExtra({pwd: 'charlie', databasePassphrase: 'echo'}))
			.toEqual({pwd: '[REDACTED]', databasePassphrase: '[REDACTED]'})
	})

	it('redacts scheme-less authority credentials in diagnostics', () => {
		const value = String(redactErrorValue('connection failed for admin:local-secret@localhost:5432'))
		expect(value).not.toContain('admin')
		expect(value).not.toContain('local-secret')
		expect(value).toContain('[DROPPED]')
	})

	it('redacts free-form tenant, user, session, and relative-path identifiers', () => {
		const diagnostic = redactErrorValue(
			'user_id=alice tenant:acme session-key="short-session" request /workspaces/acme/jobs/42'
		)
		const serialized = JSON.stringify(diagnostic)
		expect(serialized).not.toContain('alice')
		expect(serialized).not.toContain('short-session')
		expect(serialized).not.toContain('/workspaces/acme')
		expect(serialized).toContain('[DROPPED]')
	})

	it('redacts compound credential, identifier, and personal-data keys', () => {
		const redacted = redactErrorValue({
			'x-api-key': 'short-secret',
			awsSecretAccessKey: 'also-short',
			passwordConfirmation: 'confirmed-secret',
			actorUserId: 'user-123',
			sessionIdHash: 'session-123',
			billingPhone: '5551234',
			contactEmail: 'short-at-local',
			primaryEmailVerified: true
		}) as Record<string, unknown>

		expect(redacted['x-api-key']).toBe('[REDACTED]')
		expect(redacted.awsSecretAccessKey).toBe('[REDACTED]')
		expect(redacted.passwordConfirmation).toBe('[REDACTED]')
		expect(redacted.actorUserId).toMatch(/^hash:/u)
		expect(redacted.sessionIdHash).toMatch(/^hash:/u)
		expect(redacted.billingPhone).toBe('[DROPPED]')
		expect(redacted.contactEmail).toBe('[DROPPED]')
		expect(redacted.primaryEmailVerified).toBe('[DROPPED]')
		const identifiers = redactEnrichedError({
			...error, code: 'TOKEN_LEAK', source: 'client-secret', id: 'access-key'
		})
		expect(identifiers.code).not.toBe('TOKEN_LEAK')
		expect(identifiers.source).not.toBe('client-secret')
		expect(identifiers.id).not.toBe('access-key')
	})

	it('redacts request and tracing identifiers in payloads and free-form diagnostics', () => {
		const redacted = redactErrorValue({
			requestId: 'short-request',
			correlationId: 'short-correlation',
			traceId: 'short-trace',
			spanId: 'short-span',
			message: 'request_id=short-request traceId:short-trace span=short-span'
		}) as Record<string, unknown>

		expect(redacted.requestId).toMatch(/^hash:/u)
		expect(redacted.correlationId).toMatch(/^hash:/u)
		expect(redacted.traceId).toMatch(/^hash:/u)
		expect(redacted.spanId).toMatch(/^hash:/u)
		expect(redacted.message).not.toContain('short-request')
		expect(redacted.message).not.toContain('short-trace')
		expect(redacted.message).not.toContain('short-span')
	})

	it('uses the supplied clock for built-in custom deduplication', async() => {
		let now = 1
		const report = vi.fn(async() => {})
		const handler = createErrorHandler({
			clock: {now: () => now}, deduplicate: true, report
		})
		await handler.handle(new Error('same'))
		await handler.handle(new Error('same'))
		expect(report).toHaveBeenCalledTimes(1)
		now += 10_001
		await handler.handle(new Error('same'))
		expect(report).toHaveBeenCalledTimes(2)
		await handler.shutdown()
	})

	it('reports only once when identical errors are handled concurrently', async() => {
		const report = vi.fn(async() => {})
		const handler = createErrorHandler({
			clock: createFixedClock(1), deduplicate: true, report
		})

		await Promise.all(Array.from({length: 20}, async() => await handler.handle(new Error('same'))))

		expect(report).toHaveBeenCalledTimes(1)
		await handler.shutdown()
	})

	it('forwards built-in deduplication throttling to the configured observer', async() => {
		const observe = vi.fn()
		const handler = createErrorHandler({
			clock: createFixedClock(1), deduplicate: true, observe
		})

		for (let index = 0; index < 10; index += 1) {
			await handler.handle(new Error('token=throttle-secret'))
		}

		expect(observe).toHaveBeenCalledWith('error:throttled', expect.objectContaining({
			kind: 'Error', category: 'UNKNOWN', count: 10, threshold: 10
		}))
		expect(JSON.stringify(observe.mock.calls)).not.toContain('throttle-secret')
		await handler.shutdown()
	})

	it('rejects accessor-backed and hidden option fields instead of silently dropping configuration', async() => {
		const getter = vi.fn(() => ({capture: vi.fn(async() => {})}))
		const accessorOptions = Object.create(null) as Record<string, unknown>
		Object.defineProperty(accessorOptions, 'sink', {enumerable: true, get: getter})
		expect(() => createErrorHandler(accessorOptions as never)).toThrow('errors_invalid_options')
		await expect(createProductionErrorHandler(accessorOptions as never)).rejects.toThrow('errors_invalid_options')

		const hiddenOptions = Object.create(null) as Record<string, unknown>
		Object.defineProperty(hiddenOptions, 'clock', {enumerable: false, value: createFixedClock(1)})
		expect(() => createErrorHandler(hiddenOptions as never)).toThrow('errors_invalid_options')

		const ports = Object.create(null) as Record<string, unknown>
		Object.defineProperty(ports, 'logger', {enumerable: true, get: getter})
		expect(() => createErrorHandler({ports} as never)).toThrow('errors_invalid_ports')
		expect(getter).not.toHaveBeenCalled()
	})

	it('does not invoke accessor-backed reporter, sink, or runtime capabilities', async() => {
		const capabilityGetter = vi.fn(() => { throw new Error('must not execute') })
		const sink = Object.create(null) as Record<string, unknown>
		Object.defineProperty(sink, 'capture', {get: capabilityGetter})
		expect(() => createErrorHandler({sink: sink as never})).toThrow('errors_invalid_sink')

		const logger = Object.create(null) as Record<string, unknown>
		Object.defineProperty(logger, 'error', {get: capabilityGetter})
		const runtime = createReportRuntime({logger: logger as never})
		await runtime.report({
			kind: 'Error', message: 'safe', code: 'SAFE', severity: 'error',
			category: 'UNKNOWN', timestamp: 1, source: 'test'
		})
		await runtime.shutdown()
		expect(capabilityGetter).not.toHaveBeenCalled()
	})

	it('bounds hostile Sentry projections without invoking accessors or polluting prototypes', () => {
		const throwingKeys = new Proxy({}, {ownKeys() { throw new Error('blocked') }})
		expect(sanitizeSentryTags(throwingKeys as Record<string, string>)).toEqual({})
		expect(sanitizeSentryExtra(throwingKeys)).toBe('[Unserializable]')

		const throwingDescriptor = new Proxy({safe: 'value'}, {
			getOwnPropertyDescriptor() { throw new Error('blocked') }
		})
		expect(sanitizeSentryTags(throwingDescriptor as Record<string, string>)).toEqual({})
		expect(sanitizeSentryExtra(throwingDescriptor)).toEqual({})
		const hostileArray = new Proxy([], {
			getOwnPropertyDescriptor() { throw new Error('blocked') }
		})
		expect(sanitizeSentryExtra(hostileArray)).toBe('[Unserializable]')

		const sparse = new Array(2) as unknown[]
		sparse[1] = 'value'
		expect(sanitizeSentryExtra(sparse)).toEqual([null, 'value'])
		const circular: unknown[] = []
		circular.push(circular)
		expect(sanitizeSentryExtra(circular)).toEqual(['[Circular]'])

		const tags = Object.create(null) as Record<PropertyKey, unknown>
		tags[' invalid key '] = 'value'
		tags.nonString = 1
		tags[''] = 'empty-key'
		tags['x'.repeat(129)] = 'oversized-key'
		tags[Symbol('tag')] = 'symbol-value'
		Object.defineProperty(tags, 'accessor', {enumerable: true, get: () => 'hidden'})
		const projected = sanitizeSentryTags(tags as Record<string, string>)
		const sanitizedInvalidKey = Object.keys(projected).find((key) => key.startsWith('tag_'))
		expect(sanitizedInvalidKey).toBeDefined()
		expect(projected[sanitizedInvalidKey!]).toBe('value')
		expect(projected).not.toHaveProperty('nonString')

		expect(sanitizeSentryString('safe words '.repeat(500))).toHaveLength(4_099)
		expect(sanitizeSentryTagValue('source', 'errors')).toBe('errors')
		expect(sanitizeSentryTagValue('source', 'custom-source')).toMatch(/^source:/u)
		expect(sanitizeSentryTagValue('environment', 'production')).toBe('production')
		expect(sanitizeSentryTagValue('tag', '550e8400-e29b-41d4-a716-446655440000')).toBe('id')
		expect(sanitizeSentryTagValue('tag', 'abcdefabcdefabcdef')).toBe('token')
		expect(sanitizeSentryTagValue('tag', 'org-production')).toMatch(/^id:/u)
		expect(sanitizeSentryTagValue('tag', 'path/1234')).toMatch(/^id:/u)
		expect(sanitizeSentryTagValue('tag', 'x'.repeat(4_097))).toBe('oversized')
		expect(sentryStackFrames()).toBeUndefined()
		expect(sentryStackFrames('Error only')).toBeUndefined()
	})

	it('redacts quoted secret assignments across the full bounded scan window', () => {
		const secret = `prefix ${'sensitive value '.repeat(400)}`
		const redacted = redactErrorValue(`password="${secret}"`) as string

		expect(redacted).toBe('password=[REDACTED]')
		expect(redacted).not.toContain('sensitive value')
	})

	it('enforces aggregate node and character budgets for diagnostic projections', () => {
		const wide = Array.from({length: 50}, (_value, outer) => Object.fromEntries(
			Array.from({length: 50}, (_entry, inner) => [`value${inner}`, `${outer}-${inner}`])
		))
		const characterHeavy = Array.from({length: 100}, () => 'x'.repeat(4_096))
		const compressedSecrets = redactErrorValue({
			first: `token=${'a'.repeat(60_000)}`,
			second: `password=${'b'.repeat(60_000)}`,
			tail: 'c'.repeat(20_000)
		}) as Record<string, unknown>
		const keyHeavy = {
			message: 'm'.repeat(60_000),
			groups: Array.from({length: 10}, (_group, group) => Object.fromEntries(
				Array.from({length: 190}, (_entry, index) => [
					`field_${group}_${index}`.padEnd(64, 'x'),
					''
				])
			))
		}
		const redactedJson = JSON.stringify({wide: redactErrorValue(wide), characters: redactErrorValue(characterHeavy)})
		const sentryJson = JSON.stringify({wide: sanitizeSentryExtra(wide), characters: sanitizeSentryExtra(characterHeavy)})
		const enrichedJson = JSON.stringify(redactEnrichedError({
			...error,
			message: 'm'.repeat(16_000), stack: 's'.repeat(16_000),
			cause: characterHeavy, data: {characterHeavy}, context: {wide, characterHeavy}
		}))

		expect(redactedJson.length).toBeLessThan(160_000)
		expect(sentryJson.length).toBeLessThan(160_000)
		expect(enrichedJson.length).toBeLessThan(160_000)
		expect(JSON.stringify(redactErrorValue(keyHeavy)).length).toBeLessThan(160_000)
		expect(redactedJson).toContain('Truncated')
		expect(sentryJson).toContain('Truncated')
		expect(compressedSecrets).toEqual({
			first: 'token=[REDACTED]', second: 'password=[REDACTED]', tail: '[Truncated]'
		})
		expect(redactErrorValue(BigInt('9'.repeat(70_000)))).toBe('[DROPPED_OVERSIZED]')
		expect(redactEnrichedError({...error, kind: 'x'.repeat(70_000)}).kind)
			.toBe('kind:[REDACTED]')
	})

	it('creates distinct valid Sentry event IDs when runtime randomness is unavailable', () => {
		const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock unavailable') })
		const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random unavailable') })
		vi.stubGlobal('crypto', {
			randomUUID: () => undefined,
			getRandomValues: (bytes: Uint8Array) => bytes
		})
		try {
			const first = createSentryEvent(error, {dsn: 'https://public@example.com/42'})
			const second = createSentryEvent(error, {dsn: 'https://public@example.com/42'})
			expect(first.event_id).toMatch(/^[a-f0-9]{32}$/u)
			expect(second.event_id).toMatch(/^[a-f0-9]{32}$/u)
			expect(second.event_id).not.toBe(first.event_id)
			expect(first).toMatchObject({sdk: {name: '@ooopsstudio/errors'}})
			expect(first).not.toHaveProperty('_sdk')
		} finally {
			vi.unstubAllGlobals()
			dateNow.mockRestore()
			random.mockRestore()
		}
	})

	it('covers bounded redaction fallbacks for hostile runtime values', () => {
		const throwingHash = new Proxy({}, {ownKeys() { throw new Error('blocked') }})
		expect(redactErrorValue({userId: throwingHash})).toMatchObject({userId: '[REDACTED]'})
		const throwingFunction = new Proxy(function safe() {}, {
			get(_target, key) { if (key === 'name') throw new Error('blocked'); return undefined }
		})
		expect(redactErrorValue(throwingFunction)).toBe('[Function:safe]')
		expect(redactErrorValue('safe words '.repeat(2_000))).toMatch(/\.\.\.$/u)
		expect(redactErrorValue(`/${'segment/'.repeat(4_000)}`)).toBe('/[REDACTED]/')
		expect(redactErrorValue('connect postgres://admin:database-secret@db.internal/app')).not.toContain('database-secret')
		const sparseValues = new Array(2) as unknown[]
		sparseValues[1] = 'value'
		expect(redactErrorValue(sparseValues)).toEqual([null, 'value'])
		expect(redactErrorValue(Object.fromEntries(
			Array.from({length: 201}, (_value, index) => [`key${index}`, index])
		))).toHaveProperty('__truncated', true)
		expect(redactErrorValue(new Proxy({}, {ownKeys() { throw new Error('blocked') }}))).toBe('[REDACTED]')
		expect(sanitizeErrorDiagnostic({value: 1})).toBe('[REDACTED]')
		expect(sanitizeErrorDiagnostic('safe words '.repeat(200))).toHaveLength(1_027)
		expect(sanitizeErrorDiagnosticId('bad id with spaces')).toMatch(/^id:hash:/u)
		expect(sanitizeErrorDiagnosticId('tenant-acme')).toMatch(/^id:hash:/u)
		expect(sanitizeErrorDiagnosticId('workspace-12345')).toMatch(/^id:hash:/u)
		expect(sanitizeErrorDiagnosticId('trace-id-789')).toBe('trace-id-789')
		const privatePath = redactEnrichedError({
			...error,
			source: 'tenant-acme',
			stack: 'Error: failed\n    at /Users/alice/private/app.ts:1:1'
		})
		expect(privatePath.source).toMatch(/^source:hash:/u)
		expect(privatePath.stack).not.toContain('alice')

		const malformed = {
			kind: '', message: 1, severity: 'invalid', category: 'invalid', timestamp: -1,
			data: 'not-a-record', context: [], code: 'bad code', source: 'token=secret',
			id: '', correlationId: 'bad id', traceId: 'token=secret'
		} as unknown as EnrichedError
		expect(redactEnrichedError(malformed)).toMatchObject({
			kind: 'UnknownError', message: '[REDACTED]', severity: 'error', category: 'UNKNOWN', timestamp: 0
		})
		expect(redactEnrichedError({...error, timestamp: Number.MAX_SAFE_INTEGER}).timestamp).toBe(0)
		expect(redactEnrichedError(null as unknown as EnrichedError)).toMatchObject({kind: 'UnknownError'})
	})
})
