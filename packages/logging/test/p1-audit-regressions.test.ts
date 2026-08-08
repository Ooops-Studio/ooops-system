import {afterEach, describe, expect, it, vi} from 'vitest'

import {
	MAX_ACTIVE_DIRECT_DELIVERIES,
	MAX_ACTIVE_LOG_PIPELINES,
	MAX_ACTIVE_PROVIDER_OPERATIONS,
	MAX_ACTIVE_REMOTE_REQUESTS,
	MAX_ACTIVE_TRANSFERS
} from '../src/constants'
import {createLogger} from '../src/core/logger'
import {safeClockNow, snapshotLoggingClock} from '../src/core/logger-helpers'
import {createRedacting} from '../src/core/redacting'
import {redactFreeformValue, redactString} from '../src/core/redacting-utilities'
import {
	createTransferLifecycleReentryState,
	invokeTransferLifecycle,
	isTransferLifecycleStateReentry
} from '../src/core/transfer-lifecycle-reentry'
import {createTransferring} from '../src/core/transferring'
import {createDynamicProvidersEnriching, DYNAMIC_PROVIDER_TIMEOUT_MS} from '../src/features/enriching/dynamic-providers'
import {formatPretty} from '../src/features/formatting/pretty'
import {normalizeFormattingValue} from '../src/features/formatting/safe-value'
import {consoleSink} from '../src/features/transferring/console'
import {FAILED_DELIVERY_LINES} from '../src/features/transferring/delivery'
import {httpSink} from '../src/features/transferring/http'
import {registerLogging} from '../src/index'
import {createCustomLogging} from '../src/public/custom'
import {createCustomRedacting} from '../src/public/custom-stages'
import {createCustomTransferring} from '../src/public/custom-transferring'
import {createDevelopmentLogging} from '../src/public/development'
import {createFanoutTransferring} from '../src/public/fanout-transferring'
import {createProductionRemoteTransferring} from '../src/public/production-remote-transferring'
import {snapshotExternalLoggingSink} from '../src/sinks/external'
import {createLokiLoggingSink} from '../src/sinks/providers/loki'
import type {TransferringHandle} from '../src/types/transferring'
import {copyLogAttributes} from '../src/utils/enriching'
import {SAFE_DEFAULT_REDACTING_POLICY} from '../src/utils/redaction-policy'

const clock = {now: () => 1}
const nodeProcess = globalThis.process

function stubProcessStreams(stdout: unknown, stderr: unknown): void {
	const replacement = Object.create(nodeProcess)
	Object.defineProperties(replacement, {
		stdout: {value: stdout, enumerable: true},
		stderr: {value: stderr, enumerable: true}
	})
	vi.stubGlobal('process', replacement)
}

const telemetry = () => ({
	queueSize: 0,
	writtenTotal: 0,
	droppedTotal: 0,
	retriedTotal: 0,
	sinkState: 'healthy' as const
})

describe('logging P1 audit regressions', () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('preserves lifecycle containment across nested use of the same state', async() => {
		const state = createTransferLifecycleReentryState()

		await invokeTransferLifecycle(state, async() => {
			expect(isTransferLifecycleStateReentry(state)).toBe(true)
			await invokeTransferLifecycle(state, () => {
				expect(isTransferLifecycleStateReentry(state)).toBe(true)
			})
			expect(isTransferLifecycleStateReentry(state)).toBe(true)
		})

		expect(isTransferLifecycleStateReentry(state)).toBe(false)
	})

	it.each([
		/(a+)+$/u,
		/(a+)?b/u,
		/(a|aa)+$/u,
		/a+a+$/u,
		/a+z/u,
		/a{1,1000}z/u,
		/^safe|a+z/u,
		/^a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?aaaaaaaaaaaaaaaz/u,
		/a{1000000}/u,
		/(a)\1/u,
		/(?=a)a/u
	])('rejects potentially super-linear custom redaction pattern %s', async(pattern) => {
		await expect(createCustomRedacting({additionalValuePatterns: [pattern]}))
			.rejects.toThrow('Custom logging redaction RegExp must be linear-time safe')
	})

	it.each([
		['additional keys', {additionalKeys: [/(a+)+$/u]}],
		['additional rules', {additionalRules: [{key: /(a+)+$/u, action: 'mask' as const}]}]
	])('applies the safe-pattern boundary to custom %s', async(_label, options) => {
		await expect(createCustomRedacting(options))
			.rejects.toThrow('Custom logging redaction RegExp must be linear-time safe')
	})

	it('accepts a bounded custom redaction pattern', async() => {
		const redacting = await createCustomRedacting({additionalKeys: [/^internal_[a-z]+$/u]})
		const result = await redacting({
			level: 'info', time: 1, message: 'safe',
			context: {attributes: {internal_value: 'private-value'}}
		})
		expect(result.context?.attributes).toEqual({internal_value: '***'})
	})

	it.each([
		['additionalKeys', {additionalKeys: Array.from({length: 33}, (_, index) => `key${index}`)}, 32],
		['additionalValuePatterns', {additionalValuePatterns: Array.from({length: 33}, () => /safe/u)}, 32],
		['additionalRules', {
			additionalRules: Array.from({length: 65}, (_, index) => ({path: [`field${index}`], action: 'mask' as const}))
		}, 64]
	])('bounds custom redaction %s configuration', async(name, options, maximum) => {
		await expect(createCustomRedacting(options))
			.rejects.toThrow(`Custom logging ${name} must be a dense array of at most ${maximum} items`)
	})

	it('snapshots a mutable RegExp source before validating it', async() => {
		let sourceReads = 0
		class MutablePattern extends RegExp {
			override get source(): string {
				sourceReads += 1
				return sourceReads === 1 ? '^private-value$' : '(a+)+$'
			}
		}
		const redacting = await createCustomRedacting({
			additionalValuePatterns: [new MutablePattern('unused', 'u')]
		})
		const result = await redacting({
			level: 'info', time: 1, message: 'safe',
			context: {attributes: {value: 'private-value'}}
		})

		expect(sourceReads).toBe(1)
		expect(result.context?.attributes).toEqual({value: '***'})
	})

	it('contains synchronous lifecycle diagnostics that re-enter the same logger', async() => {
		let logger: ReturnType<typeof createLogger> | undefined
		let statusReads = 0
		const write = vi.fn()
		const lifecycle = {
			getStatus: () => {
				statusReads += 1
				if (logger) void logger.info('lifecycle diagnostic')
				return {state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}
			},
			registerShutdownHook: () => () => undefined,
			registerFlushHook: () => () => undefined
		}
		logger = createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write, flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry},
			clock, 'trace', 'json', undefined, undefined, false, undefined,
			lifecycle as never
		)

		await logger.info('outer')
		await logger.flush()

		expect(statusReads).toBe(2)
		expect(write).toHaveBeenCalledTimes(2)
		await logger.shutdown()
	})

	it('keeps lifecycle shutdown retryable after a transient transfer failure', async() => {
		let shutdownHook: (() => Promise<void>) | undefined
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
				shutdownHook = hook
				return disposeShutdown
			},
			registerFlushHook: () => disposeFlush
		}
		const close = vi.fn()
			.mockRejectedValueOnce(new Error('transient close failure'))
			.mockResolvedValueOnce(undefined)
		createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write: vi.fn(), flush: vi.fn(async() => undefined), close, telemetry},
			clock, 'info', 'json', undefined, undefined, false, undefined,
			lifecycle as never
		)

		await expect(shutdownHook?.()).rejects.toThrow('transient close failure')
		expect(disposeShutdown).not.toHaveBeenCalled()
		expect(disposeFlush).not.toHaveBeenCalled()

		await expect(shutdownHook?.()).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledTimes(2)
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
	})

	it('does not replay a surfaced close failure into the next transfer retry', async() => {
		const close = vi.fn()
			.mockRejectedValueOnce(new Error('transient sink close failure'))
			.mockResolvedValueOnce(undefined)
		const transfer = createTransferring({
			sink: {write: vi.fn(), flush: vi.fn(async() => undefined), close},
			clock
		})

		await expect(transfer.close()).rejects.toThrow('transient sink close failure')
		await expect(transfer.close()).resolves.toBeUndefined()

		expect(close).toHaveBeenCalledTimes(2)
		expect(transfer.telemetry().sinkState).toBe('closed')
	})

	it('does not admit writes after an ambiguous physical close failure', async() => {
		let physicallyClosed = false
		const write = vi.fn(async() => {
			if (physicallyClosed) throw new Error('write reached a physically closed sink')
		})
		const close = vi.fn()
			.mockImplementationOnce(async() => {
				physicallyClosed = true
				throw new Error('close acknowledgement lost')
			})
			.mockResolvedValueOnce(undefined)
		const transfer = createTransferring({sink: {write, close}, clock})

		await expect(transfer.close()).rejects.toThrow('close acknowledgement lost')
		transfer.write('must-not-be-admitted')
		await expect(transfer.close()).resolves.toBeUndefined()

		expect(write).not.toHaveBeenCalled()
		expect(close).toHaveBeenCalledTimes(2)
		expect(transfer.telemetry().sinkState).toBe('closed')
	})

	it('does not admit custom writes after an ambiguous physical close failure', async() => {
		let physicallyClosed = false
		const write = vi.fn(async() => {
			if (physicallyClosed) throw new Error('custom write reached a physically closed sink')
		})
		const close = vi.fn()
			.mockImplementationOnce(async() => {
				physicallyClosed = true
				throw new Error('custom close acknowledgement lost')
			})
			.mockResolvedValueOnce(undefined)
		const transfer = await createCustomTransferring({write, close}, clock, {})

		await expect(transfer.close()).rejects.toThrow('custom close acknowledgement lost')
		transfer.write('must-not-be-admitted')
		await expect(transfer.close()).resolves.toBeUndefined()

		expect(write).not.toHaveBeenCalled()
		expect(close).toHaveBeenCalledTimes(2)
		expect(transfer.telemetry().sinkState).toBe('closed')
	})

	it('does not accept writes after the physical sink closed with an earlier delivery failure', async() => {
		const write = vi.fn().mockRejectedValue(new Error('terminal delivery failure'))
		const close = vi.fn(async() => undefined)
		const transfer = createTransferring({sink: {write, close}, clock})

		transfer.write('before-close')
		await expect(transfer.close()).rejects.toThrow('terminal delivery failure')
		expect(close).toHaveBeenCalledOnce()
		expect(transfer.telemetry().sinkState).toBe('closed')

		transfer.write('after-close')
		await expect(transfer.close()).resolves.toBeUndefined()
		expect(write).toHaveBeenCalledOnce()
		expect(close).toHaveBeenCalledOnce()
	})

	it('does not accept custom writes after physical close succeeds with a delivery failure', async() => {
		const write = vi.fn().mockRejectedValue(Object.assign(new Error('custom delivery failure'), {
			knownNoDelivery: true
		}))
		const close = vi.fn(async() => undefined)
		const transfer = await createCustomTransferring({write, close}, clock, {})

		transfer.write('before-close')
		await expect(transfer.close()).rejects.toThrow('custom delivery failure')
		expect(close).toHaveBeenCalledOnce()
		expect(transfer.telemetry().sinkState).toBe('closed')

		transfer.write('after-close')
		await expect(transfer.close()).resolves.toBeUndefined()
		expect(write).toHaveBeenCalledOnce()
		expect(close).toHaveBeenCalledOnce()
	})

	it('does not trust a sink failure that impersonates a logger flush timeout', async() => {
		const close = vi.fn(async() => undefined)
		const spoofedTimeout = new Error('logging flush timed out after 1ms')
		const logger = createLogger(
			async(record) => record,
			async(record) => record,
			() => 'line',
			{
				write: vi.fn(),
				flush: vi.fn().mockRejectedValue(spoofedTimeout),
				close,
				telemetry
			},
			clock,
			'info',
			'json'
		)

		await expect(logger.shutdown()).rejects.toBe(spoofedTimeout)
		expect(close).toHaveBeenCalledOnce()
	})

	it('preserves the lifecycle shutdown hook until every disposer succeeds', async() => {
		let shutdownHook: (() => Promise<void>) | undefined
		const disposeShutdown = vi.fn()
		const disposeFlush = vi.fn()
			.mockImplementationOnce(() => { throw new Error('transient disposer failure') })
			.mockImplementationOnce(() => undefined)
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
				shutdownHook = hook
				return disposeShutdown
			},
			registerFlushHook: () => disposeFlush
		}
		const close = vi.fn(async() => undefined)
		createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write: vi.fn(), flush: vi.fn(async() => undefined), close, telemetry},
			clock, 'info', 'json', undefined, undefined, false, undefined,
			lifecycle as never
		)

		await expect(shutdownHook?.()).rejects.toThrow('transient disposer failure')
		expect(disposeShutdown).not.toHaveBeenCalled()

		await expect(shutdownHook?.()).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledTimes(2)
		expect(disposeShutdown).toHaveBeenCalledOnce()
	})

	it('awaits asynchronous lifecycle disposers before reporting shutdown complete', async() => {
		let shutdownHook: (() => Promise<void>) | undefined
		let resolveFlushDisposer!: () => void
		const disposeShutdown = vi.fn(async() => undefined)
		const disposeFlush = vi.fn(() => new Promise<void>((resolve) => { resolveFlushDisposer = resolve }))
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
				shutdownHook = hook
				return disposeShutdown
			},
			registerFlushHook: () => disposeFlush
		}
		const logger = createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write: vi.fn(), flush: vi.fn(async() => undefined), close: vi.fn(async() => undefined), telemetry},
			clock, 'info', 'json', undefined, undefined, false, undefined,
			lifecycle as never
		)

		let settled = false
		const shuttingDown = shutdownHook?.().then(() => { settled = true })
		await vi.waitFor(() => expect(disposeFlush).toHaveBeenCalledOnce())
		expect(settled).toBe(false)
		expect(disposeShutdown).not.toHaveBeenCalled()
		expect(logger.getStatus().state).toBe('draining')
		let concurrentSettled = false
		const concurrentShutdown = shutdownHook?.().then(() => { concurrentSettled = true })
		await Promise.resolve()
		expect(concurrentSettled).toBe(false)

		resolveFlushDisposer()
		await Promise.all([shuttingDown, concurrentShutdown])
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(logger.getStatus().state).toBe('closed')
	})

	it('retries an asynchronously rejected lifecycle disposer', async() => {
		let shutdownHook: (() => Promise<void>) | undefined
		const disposeShutdown = vi.fn(async() => undefined)
		const disposeFlush = vi.fn()
			.mockRejectedValueOnce(new Error('async disposer failure'))
			.mockResolvedValueOnce(undefined)
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
				shutdownHook = hook
				return disposeShutdown
			},
			registerFlushHook: () => disposeFlush
		}
		createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write: vi.fn(), flush: vi.fn(async() => undefined), close: vi.fn(async() => undefined), telemetry},
			clock, 'info', 'json', undefined, undefined, false, undefined,
			lifecycle as never
		)

		await expect(shutdownHook?.()).rejects.toThrow('async disposer failure')
		expect(disposeShutdown).not.toHaveBeenCalled()
		await expect(shutdownHook?.()).resolves.toBeUndefined()
		expect(disposeFlush).toHaveBeenCalledTimes(2)
		expect(disposeShutdown).toHaveBeenCalledOnce()
	})

	it('contains shutdown-hook re-entry from an asynchronous lifecycle disposer', async() => {
		let shutdownHook: (() => Promise<void>) | undefined
		const disposeShutdown = vi.fn(async() => {
			await Promise.resolve()
			await shutdownHook?.()
		})
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
				shutdownHook = hook
				return disposeShutdown
			},
			registerFlushHook: () => async() => undefined
		}
		const logger = createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write: vi.fn(), flush: vi.fn(async() => undefined), close: vi.fn(async() => undefined), telemetry},
			clock, 'info', 'json', undefined, undefined, false, undefined,
			lifecycle as never, {shutdownTimeoutMs: 100}
		)

		await expect(shutdownHook?.()).resolves.toBeUndefined()
		expect(disposeShutdown).toHaveBeenCalledOnce()
		expect(logger.getStatus().state).toBe('closed')
	})

	it('rejects lifecycle registration that cannot be safely finalized', async() => {
		const close = vi.fn(async() => undefined)
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: () => undefined,
			registerFlushHook: () => () => undefined
		}

		await expect(createCustomLogging({
			clock,
			lifecycle: lifecycle as never,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write: vi.fn(), close}}},
			delivery: {mode: 'direct', circuitBreaker: false},
			selfMetrics: false
		})).rejects.toThrow('registerShutdownHook() must return a disposer function')
		expect(close).toHaveBeenCalledOnce()
	})

	it('observes a rejected async lifecycle registration result before rejecting it', async() => {
		let rejectionHandled = false
		const close = vi.fn(async() => undefined)
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: () => ({
				then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
					rejectionHandled = true
					reject(new Error('async registration failure'))
				}
			}),
			registerFlushHook: () => () => undefined
		}

		await expect(createCustomLogging({
			clock,
			lifecycle: lifecycle as never,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write: vi.fn(), close}}},
			delivery: {mode: 'direct', circuitBreaker: false},
			selfMetrics: false
		})).rejects.toThrow('registerShutdownHook() must return a disposer function')
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(rejectionHandled).toBe(true)
		expect(close).toHaveBeenCalledOnce()
	})

	it('snapshots lifecycle capabilities before the first construction await', async() => {
		const originalShutdownRegistration = vi.fn(() => () => undefined)
		const originalFlushRegistration = vi.fn(() => () => undefined)
		const mutatedShutdownRegistration = vi.fn(() => () => undefined)
		const mutatedFlushRegistration = vi.fn(() => () => undefined)
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: originalShutdownRegistration,
			registerFlushHook: originalFlushRegistration
		}
		const creating = createCustomLogging({clock, lifecycle: lifecycle as never, selfMetrics: false})
		lifecycle.registerShutdownHook = mutatedShutdownRegistration
		lifecycle.registerFlushHook = mutatedFlushRegistration

		const logger = await creating
		expect(originalShutdownRegistration).toHaveBeenCalledOnce()
		expect(originalFlushRegistration).toHaveBeenCalledOnce()
		expect(mutatedShutdownRegistration).not.toHaveBeenCalled()
		expect(mutatedFlushRegistration).not.toHaveBeenCalled()
		await logger.shutdown()
	})

	it('does not admit arbitrary lifecycle health values into log records', async() => {
		const write = vi.fn()
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const lifecycle = {
			getStatus: () => ({
				state: 'running' as const,
				health: 'opaque-lifecycle-health-secret',
				activeHooks: 0,
				failedChecks: 0
			}),
			registerShutdownHook: () => () => undefined,
			registerFlushHook: () => () => undefined
		}
		const logger = createLogger(
			async(record) => record, redacting, (record) => JSON.stringify(record),
			{write, flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry},
			clock, 'trace', 'json', undefined, undefined, false, undefined, lifecycle as never
		)

		logger.info('health boundary')
		await logger.flush()

		expect(write).toHaveBeenCalledOnce()
		expect(write.mock.calls[0]?.[0]).not.toContain('opaque-lifecycle-health-secret')
		expect(write.mock.calls[0]?.[0]).toContain('unhealthy')
		await logger.shutdown()
	})

	it('owns registration before caller-controlled container lookup can re-enter', async() => {
		const values = new Map<symbol, unknown>()
		let nested: Promise<void> | undefined
		let reentered = false
		const container = {
			has: vi.fn((token: symbol) => {
				if (!reentered) {
					reentered = true
					nested = registerLogging(container as never, {preset: 'development'})
					void nested.catch(() => undefined)
				}
				return values.has(token)
			}),
			get: vi.fn(() => clock),
			tryGet: vi.fn((token: symbol) => values.get(token)),
			bind: vi.fn((token: symbol, value: unknown) => { values.set(token, value) }),
			unbind: vi.fn((token: symbol) => values.delete(token))
		}

		await expect(registerLogging(container as never, {preset: 'development'}))
			.resolves.toBeUndefined()
		await expect(nested).rejects.toThrow('Logging service is already registered')
		const logger = [...values.values()].find((value) => value && typeof value === 'object'
			&& 'shutdown' in value) as {shutdown(): Promise<void>} | undefined
		await logger?.shutdown()
	})

	it('rolls back a runtime synchronously shut down by the container bind', async() => {
		let registered: {shutdown(): Promise<void>; getStatus(): {state: string}} | undefined
		let binding: unknown
		const container = {
			has: vi.fn(() => false),
			get: vi.fn(() => clock),
			tryGet: vi.fn(() => binding),
			bind: vi.fn((_token: symbol, value: unknown) => {
				registered = value as typeof registered
				binding = value
				void registered?.shutdown()
			}),
			unbind: vi.fn(() => { binding = undefined; return true })
		}

		await expect(registerLogging(container as never, {preset: 'development'}))
			.rejects.toThrow('Logging runtime became unavailable during registration')
		expect(container.unbind).toHaveBeenCalledOnce()
		expect(binding).toBeUndefined()
		expect(registered?.getStatus().state).toBe('closed')
	})

	it('removes a partial binding when post-bind ownership verification is unavailable', async() => {
		let registered: {getStatus(): {state: string}} | undefined
		let binding: unknown
		let bindAttempted = false
		const container = {
			has: vi.fn(() => false),
			get: vi.fn(() => clock),
			tryGet: vi.fn(() => {
				if (bindAttempted) throw new Error('post-bind lookup unavailable')
				return undefined
			}),
			bind: vi.fn((_token: symbol, value: unknown) => {
				binding = value
				registered = value as typeof registered
				bindAttempted = true
				throw new Error('bind acknowledgement lost')
			}),
			unbind: vi.fn(() => { binding = undefined; return true })
		}

		await expect(registerLogging(container as never, {preset: 'development'}))
			.rejects.toThrow('bind acknowledgement lost')

		expect(container.unbind).toHaveBeenCalledOnce()
		expect(binding).toBeUndefined()
		expect(registered?.getStatus().state).toBe('closed')
	})

	it('snapshots remote configuration before the first construction await', async() => {
		const fetchRequest = vi.fn().mockResolvedValue(new Response(null, {status: 204}))
		vi.stubGlobal('fetch', fetchRequest)
		const remote = {provider: 'http' as const, url: 'https://original.example.com/logs'}
		const creating = createCustomLogging({
			clock,
			destinations: {stdout: false, remote},
			delivery: {mode: 'direct'},
			selfMetrics: false
		})
		remote.url = 'https://mutated.example.com/logs'
		const logger = await creating

		logger.info('remote snapshot')
		await logger.flush()

		expect(fetchRequest).toHaveBeenCalledWith('https://original.example.com/logs', expect.any(Object))
		expect(fetchRequest).not.toHaveBeenCalledWith('https://mutated.example.com/logs', expect.any(Object))
		await logger.shutdown()
	})

	it('captures a custom remote sink before the first construction await', async() => {
		const originalWrite = vi.fn(async() => undefined)
		const mutatedWrite = vi.fn(async() => undefined)
		const remote = {provider: 'custom' as const, sink: {write: originalWrite}}
		const creating = createCustomLogging({
			clock,
			destinations: {stdout: false, remote},
			delivery: {mode: 'direct'},
			selfMetrics: false
		})
		remote.sink = {write: mutatedWrite}
		const logger = await creating

		logger.info('sink snapshot')
		await logger.flush()

		expect(originalWrite).toHaveBeenCalledOnce()
		expect(mutatedWrite).not.toHaveBeenCalled()
		await logger.shutdown()
	})

	it('captures custom remote methods before the first construction await', async() => {
		const originalWrite = vi.fn(async() => undefined)
		const originalClose = vi.fn(async() => undefined)
		const mutatedWrite = vi.fn(async() => undefined)
		const mutatedClose = vi.fn(async() => undefined)
		const sink = {write: originalWrite, close: originalClose}
		const creating = createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink}},
			delivery: {mode: 'direct'},
			selfMetrics: false
		})
		sink.write = mutatedWrite
		sink.close = mutatedClose
		const logger = await creating

		logger.info('sink capability snapshot')
		await logger.flush()
		await logger.shutdown()

		expect(originalWrite).toHaveBeenCalledOnce()
		expect(originalClose).toHaveBeenCalledOnce()
		expect(mutatedWrite).not.toHaveBeenCalled()
		expect(mutatedClose).not.toHaveBeenCalled()
	})

	it('closes an acquired custom remote when stdout construction fails', async() => {
		const close = vi.fn(async() => undefined)
		const hostileProcess = Object.create(nodeProcess)
		Object.defineProperty(hostileProcess, 'stdout', {
			configurable: true,
			get() { throw new Error('stdout unavailable during construction') }
		})
		vi.stubGlobal('process', hostileProcess)

		await expect(createCustomLogging({
			clock,
			format: 'json',
			destinations: {
				stdout: true,
				remote: {provider: 'custom', sink: {write: vi.fn(async() => undefined), close}}
			},
			delivery: {mode: 'direct'}
		})).rejects.toThrow('stdout unavailable during construction')

		expect(close).toHaveBeenCalledOnce()
	})

	it('snapshots sampling policy before the first construction await', async() => {
		const write = vi.fn(async() => undefined)
		const sampling = {strategy: 'fixed-rate' as const, rate: 1, keepAtOrAbove: 'error' as const}
		const creating = createCustomLogging({
			clock,
			sampling,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
			delivery: {mode: 'direct'},
			selfMetrics: false
		})
		sampling.rate = 0
		const logger = await creating

		logger.info('sampling snapshot')
		await logger.flush()

		expect(write).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it('snapshots development sampling before the first construction await', async() => {
		const write = vi.fn(() => true)
		stubProcessStreams({write, once: vi.fn()}, {write: vi.fn(() => true), once: vi.fn()})
		const sampling = {strategy: 'fixed-rate' as const, rate: 1, keepAtOrAbove: 'error' as const}
		const creating = createDevelopmentLogging({clock, sampling, selfMetrics: false})
		sampling.rate = 0
		const logger = await creating

		logger.info('development sampling snapshot')
		await logger.flush()

		expect(write).toHaveBeenCalledWith(expect.stringContaining('development sampling snapshot'))
		await logger.shutdown()
	})

	it('snapshots development context before the first construction await', async() => {
		const write = vi.fn(() => true)
		stubProcessStreams({write, once: vi.fn()}, {write: vi.fn(() => true), once: vi.fn()})
		const attributes = {deployment: 'original'}
		const context = {namespace: 'original', attributes}
		const creating = createDevelopmentLogging({clock, context, selfMetrics: false})
		context.namespace = 'mutated'
		attributes.deployment = 'mutated'
		const logger = await creating

		logger.info('development context snapshot')
		await logger.flush()

		const output = write.mock.calls.map(([line]) => String(line)).join('\n')
		expect(output).toContain('original')
		expect(output).not.toContain('mutated')
		await logger.shutdown()
	})

	it('uses the validated circuit-breaker snapshot after asynchronous construction', async() => {
		const write = vi.fn(async() => { throw new Error('remote unavailable') })
		const circuitBreaker = {failureThreshold: 3, halfOpenAfterMs: 60_000, maxHalfOpenProbes: 1}
		const creating = createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000},
				circuitBreaker
			},
			selfMetrics: false
		})
		circuitBreaker.failureThreshold = 1
		const logger = await creating

		logger.info('first failure')
		await expect(logger.flush()).rejects.toThrow('remote unavailable')
		logger.info('second failure')
		await expect(logger.flush()).rejects.toThrow('remote unavailable')

		expect(write).toHaveBeenCalledTimes(2)
		await logger.shutdown()
	})

	it('does not retry an ambiguous HTTP 5xx through the circuit wrapper', async() => {
		const fetchRequest = vi.fn()
			.mockResolvedValueOnce({ok: false, status: 503, statusText: 'Unavailable'})
			.mockResolvedValueOnce({ok: true, status: 204, statusText: 'No Content'})
		vi.stubGlobal('fetch', fetchRequest)
		const logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'http', url: 'https://logs.example.com/v1/logs'}},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			},
			selfMetrics: false
		})

		logger.info('must not duplicate')
		await expect(logger.flush()).rejects.toMatchObject({
			code: 'HTTP_SERVER_ERROR', nonRetryable: true, ambiguousDelivery: true
		})
		expect(fetchRequest).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it.each(['http', 'loki'] as const)(
		'retries a known-undelivered %s 408 through the complete remote pipeline',
		async(provider) => {
			const fetchRequest = vi.fn()
				.mockResolvedValueOnce({ok: false, status: 408, statusText: 'Request Timeout'})
				.mockResolvedValueOnce({ok: true, status: 204, statusText: 'No Content'})
			vi.stubGlobal('fetch', fetchRequest)
			const logger = await createCustomLogging({
				clock,
				destinations: {stdout: false, remote: {provider, url: 'https://logs.example.com/ingest'}},
				delivery: {
					mode: 'direct',
					retry: {
						maxAttempts: 2, baseDelayMs: 0, multiplier: 1,
						maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000
					}
				},
				selfMetrics: false
			})

			logger.info('safe retry after request timeout')
			await expect(logger.flush()).resolves.toBeUndefined()
			expect(fetchRequest).toHaveBeenCalledTimes(2)
			await logger.shutdown()
		}
	)

	it.each(['http', 'loki'] as const)(
		'does not retry an ambiguous %s network failure through the circuit wrapper',
		async(provider) => {
			const fetchRequest = vi.fn()
				.mockRejectedValueOnce(new Error('connection lost after send'))
				.mockResolvedValueOnce({ok: true, status: 204, statusText: 'No Content'})
			vi.stubGlobal('fetch', fetchRequest)
			const logger = await createCustomLogging({
				clock,
				destinations: {stdout: false, remote: {provider, url: 'https://logs.example.com/ingest'}},
				delivery: {
					mode: 'direct',
					retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
				},
				selfMetrics: false
			})

			logger.info('must not duplicate after network uncertainty')
			await expect(logger.flush()).rejects.toMatchObject({
				code: provider === 'http' ? 'HTTP_NETWORK' : 'LOKI_NETWORK',
				nonRetryable: true,
				ambiguousDelivery: true
			})
			expect(fetchRequest).toHaveBeenCalledOnce()
			await logger.shutdown()
		}
	)

	it('does not retry an external write rejection with an unknown delivery outcome', async() => {
		const write = vi.fn()
			.mockRejectedValueOnce(new Error('connection lost after custom sink accepted the record'))
			.mockResolvedValueOnce(undefined)
		const logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			},
			selfMetrics: false
		})

		logger.info('must not duplicate through custom sink')
		await expect(logger.flush()).rejects.toMatchObject({
			code: 'DELIVERY_WRITE_AMBIGUOUS',
			nonRetryable: true,
			ambiguousDelivery: true
		})
		expect(write).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it.each([false, true])(
		'does not retry an explicitly ambiguous external write even when knownNoDelivery=%s',
		async(knownNoDelivery) => {
			const write = vi.fn()
				.mockRejectedValueOnce(Object.assign(new Error('custom sink lost acknowledgement'), {
					ambiguousDelivery: true,
					knownNoDelivery,
					retryable: true
				}))
				.mockResolvedValueOnce(undefined)
			const logger = await createCustomLogging({
				clock,
				destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
				delivery: {
					mode: 'direct',
					retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
				},
				selfMetrics: false
			})

			logger.info('must not replay an explicitly ambiguous delivery')
			await expect(logger.flush()).rejects.toMatchObject({
				nonRetryable: true,
				ambiguousDelivery: true
			})
			expect(write).toHaveBeenCalledOnce()
			await logger.shutdown()
		}
	)

	it('does not retain or expose unbounded external write failure diagnostics', async() => {
		const privateValue = 'external-sink-password-secret'
		const retainedGraph = {privateValue, payload: 'x'.repeat(100_000)}
		const source = Object.assign(new Error(`password=${privateValue} ${'x'.repeat(100_000)}`), {
			code: retainedGraph,
			statusCode: retainedGraph,
			retryable: retainedGraph,
			nonRetryable: retainedGraph,
			deliveredCount: retainedGraph
		})
		const sink = snapshotExternalLoggingSink({
			write: vi.fn().mockRejectedValue(source),
			writeBatch: vi.fn().mockRejectedValue(source)
		})

		const capture = async(operation: void | Promise<void>): Promise<unknown> => {
			try { await operation } catch(error) { return error }
		}
		for (const operation of [capture(sink.write('line')), capture(sink.writeBatch!(['one', 'two']))]) {
			const failure = await operation as Error & {
				cause?: unknown
				code?: unknown
				statusCode?: unknown
				retryable?: unknown
				nonRetryable?: unknown
				deliveredCount?: unknown
			}
			expect(failure).toBeInstanceOf(Error)
			expect(failure.message).not.toContain(privateValue)
			expect(failure.message.length).toBeLessThanOrEqual(513)
			expect(failure.cause).toBeUndefined()
			expect(failure.code).toBe('DELIVERY_WRITE_AMBIGUOUS')
			expect(failure.statusCode).toBeUndefined()
			expect(failure.retryable).toBeUndefined()
			expect(failure.nonRetryable).toBe(true)
			expect(failure.deliveredCount).toBeUndefined()
		}
	})

	it('still retries an external write that explicitly guarantees no delivery', async() => {
		const write = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('rejected before delivery'), {
				knownNoDelivery: true,
				retryable: true
			}))
			.mockResolvedValueOnce(undefined)
		const logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			},
			selfMetrics: false
		})

		logger.info('safe to retry through custom sink')
		await expect(logger.flush()).resolves.toBeUndefined()
		expect(write).toHaveBeenCalledTimes(2)
		await logger.shutdown()
	})

	it('does not retry contradictory external delivery acknowledgement metadata', async() => {
		const write = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('contradictory delivery outcome'), {
				knownNoDelivery: true,
				retryable: true,
				deliveredCount: 1
			}))
			.mockResolvedValueOnce(undefined)
		const logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			},
			selfMetrics: false
		})

		logger.info('must not duplicate a contradictory acknowledgement')
		await expect(logger.flush()).rejects.toMatchObject({
			nonRetryable: true,
			ambiguousDelivery: true,
			deliveredCount: 1
		})
		expect(write).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it('does not trust accessor-backed external delivery acknowledgement metadata', async() => {
		const failure = Object.assign(new Error('hostile delivery outcome'), {
			knownNoDelivery: true,
			retryable: true
		})
		Object.defineProperty(failure, 'deliveredCount', {
			enumerable: true,
			get: () => 1
		})
		const write = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
		const logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			},
			selfMetrics: false
		})

		logger.info('must not duplicate hostile acknowledgement metadata')
		await expect(logger.flush()).rejects.toMatchObject({
			nonRetryable: true,
			ambiguousDelivery: true
		})
		expect(write).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it('does not retry external writes with pending delivery ownership', async() => {
		const write = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('delivery still pending'), {
				knownNoDelivery: true,
				retryable: true,
				pendingAmbiguousDelivery: true
			}))
			.mockResolvedValueOnce(undefined)
		const logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write}}},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 2, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			},
			selfMetrics: false
		})

		logger.info('must not replay pending physical delivery')
		await expect(logger.flush()).rejects.toMatchObject({
			nonRetryable: true,
			ambiguousDelivery: true,
			pendingAmbiguousDelivery: true
		})
		expect(write).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it('does not expose external sink credentials through the Errors port', async() => {
		const privateValue = 'custom-sink-observer-secret'
		const report = vi.fn()
		const logger = await createCustomLogging({
			clock,
			errors: {report} as never,
			destinations: {
				stdout: false,
				remote: {
					provider: 'custom',
					sink: {write: vi.fn().mockRejectedValue(new Error(`password=${privateValue}`))}
				}
			},
			delivery: {
				mode: 'direct',
				retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			},
			selfMetrics: false
		})

		logger.info('observer boundary')
		await expect(logger.flush()).rejects.toBeInstanceOf(Error)
		expect(report).toHaveBeenCalled()
		expect(JSON.stringify(report.mock.calls)).not.toContain(privateValue)
		await logger.shutdown()
	})

	it('uses captured container capabilities after registration lookup rewiring', async() => {
		const values = new Map<symbol, unknown>()
		const container = {
			has: vi.fn(() => {
				container.get = vi.fn(() => { throw new Error('password=rewired-get-secret') })
				container.bind = vi.fn(() => { throw new Error('token=rewired-bind-secret') })
				return false
			}),
			get: vi.fn(() => clock),
			tryGet: vi.fn((token: symbol) => values.get(token)),
			bind: vi.fn((token: symbol, value: unknown) => { values.set(token, value) }),
			unbind: vi.fn((token: symbol) => values.delete(token))
		}

		await expect(registerLogging(container as never, {preset: 'development'}))
			.resolves.toBeUndefined()
		const logger = [...values.values()].find((value) => value && typeof value === 'object'
			&& 'shutdown' in value) as {shutdown(): Promise<void>} | undefined
		await logger?.shutdown()
	})

	it.each(['has', 'get', 'tryGet'] as const)(
		'observes rejected asynchronous container %s results',
		async(capability) => {
			let rejectionHandled = 0
			const rejectedThenable = () => ({
				then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
					rejectionHandled += 1
					reject(new Error(`async container ${capability} failure`))
				}
			})
			const container = {
				has: vi.fn(() => capability === 'has' ? rejectedThenable() : false),
				get: vi.fn(() => capability === 'get' ? rejectedThenable() : clock),
				tryGet: vi.fn(() => capability === 'tryGet' ? rejectedThenable() : undefined),
				bind: vi.fn(),
				unbind: vi.fn(() => true)
			}

			await expect(registerLogging(container as never, {preset: 'development'}))
				.rejects.toThrow(`Logging container ${capability}() must be synchronous`)
			await new Promise<void>((resolve) => { setImmediate(resolve) })
			expect(rejectionHandled).toBe(1)
		}
	)

	it('redacts hostile container failures crossing the registration boundary', async() => {
		const clockFailureContainer = {
			has: vi.fn(() => false),
			get: vi.fn(() => { throw new Error('pass_word=clock-private') }),
			tryGet: vi.fn(() => undefined),
			bind: vi.fn(() => undefined),
			unbind: vi.fn(() => false)
		}
		const clockFailure = await registerLogging(clockFailureContainer as never, {preset: 'development'})
			.catch((error: unknown) => error)

		const values = new Map<symbol, unknown>()
		const rollbackContainer = {
			has: vi.fn((token: symbol) => values.has(token)),
			get: vi.fn(() => clock),
			tryGet: vi.fn((token: symbol) => values.get(token)),
			bind: vi.fn((token: symbol, value: unknown) => {
				values.set(token, value)
				throw new Error('password=bind-private')
			}),
			unbind: vi.fn(() => { throw new Error('api key=rollback-private') })
		}
		const rollbackFailure = await registerLogging(rollbackContainer as never, {preset: 'development'})
			.catch((error: unknown) => error)
		const serialized = JSON.stringify([clockFailure, rollbackFailure], (_key, value) => value instanceof Error
			? {message: value.message, errors: value instanceof AggregateError ? value.errors : undefined}
			: value)
		for (const secret of ['clock-private', 'bind-private', 'rollback-private']) {
			expect(serialized).not.toContain(secret)
		}
	})

	it('bounds cyclic aggregate registration failures while sanitizing diagnostics', async() => {
		const cyclic = new AggregateError([], 'password=cyclic-registration-secret')
		Object.defineProperty(cyclic, 'errors', {value: [cyclic]})
		const container = {
			has: vi.fn(() => { throw cyclic }),
			get: vi.fn(),
			tryGet: vi.fn(),
			bind: vi.fn(),
			unbind: vi.fn()
		}

		const failure = await registerLogging(container as never, {preset: 'development'})
			.then(() => undefined, (error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		expect(failure).toBeInstanceOf(AggregateError)
		expect((failure as AggregateError).errors).toHaveLength(1)
		expect(String((failure as AggregateError).errors[0])).toContain('circular logging registration failure')
		expect(String(failure)).not.toContain('cyclic-registration-secret')
	})

	it('contains lifecycle failure reporting that logs through the same logger', async() => {
		let logger: ReturnType<typeof createLogger> | undefined
		let statusReads = 0
		const write = vi.fn()
		const lifecycle = {
			getStatus: () => {
				statusReads += 1
				if (logger) throw new Error('lifecycle unavailable')
				return {state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}
			},
			registerShutdownHook: () => () => undefined,
			registerFlushHook: () => () => undefined
		}
		const errors = {
			report: vi.fn(() => {
				logger?.error('lifecycle failure diagnostic')
			})
		}
		logger = createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write, flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry},
			clock, 'trace', 'json', undefined, errors as never, false, undefined,
			lifecycle as never
		)

		logger.info('outer')
		await logger.flush()

		expect(statusReads).toBe(3)
		expect(errors.report).toHaveBeenCalledOnce()
		expect(write).toHaveBeenCalledTimes(2)
		await logger.shutdown()
	})

	it('does not execute arbitrary thenables returned by self-metrics adapters', async() => {
		const then = vi.fn()
		const metrics = {
			increment: vi.fn(() => ({then}))
		}
		const transfer = createTransferring({
			sink: {write: vi.fn(async() => undefined)},
			clock,
			selfMetrics: true,
			metrics: metrics as never
		})
		const logger = createLogger(
			async(record) => record, async(record) => record, () => 'line',
			transfer, clock, 'trace', 'json'
		)

		await logger.info('async metrics')
		await logger.flush()
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(then).not.toHaveBeenCalled()
		await logger.shutdown()
	})

	it('contains rejected asynchronous lifecycle status adapters', async() => {
		let rejectionHandled = 0
		const lifecycle = {
			getStatus: vi.fn(() => ({
				then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
					rejectionHandled += 1
					reject(new Error('async lifecycle status failure'))
				}
			})),
			registerShutdownHook: () => () => undefined,
			registerFlushHook: () => () => undefined
		}
		const logger = createLogger(
			async(record) => record, async(record) => record, () => 'line',
			{write: vi.fn(), flush: vi.fn(async() => undefined), close: vi.fn(async() => undefined), telemetry},
			clock, 'trace', 'json', undefined, undefined, false, undefined, lifecycle as never
		)

		await logger.info('async lifecycle')
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(rejectionHandled).toBeGreaterThan(0)
		expect(logger.getStatus().state).toBe('running')
		await logger.shutdown()
	})

	it('contains rejected asynchronous clock adapters', async() => {
		let rejectionHandled = 0
		const asyncClock = {
			now: () => ({
				then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
					rejectionHandled += 1
					reject(new Error('async clock failure'))
				}
			})
		}

		expect(Number.isFinite(safeClockNow(asyncClock as never))).toBe(true)
		expect(Number.isFinite(snapshotLoggingClock(asyncClock)?.now())).toBe(true)
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(rejectionHandled).toBe(2)
	})

	it('retains rejected asynchronous console writes through the flush boundary', async() => {
		let rejectionHandled = 0
		const stdout = {
			write: () => ({
				then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
					rejectionHandled += 1
					reject(new Error('async stdout failure'))
				}
			})
		}
		stubProcessStreams(stdout, stdout)
		const transfer = createTransferring({sink: consoleSink(), clock})

		transfer.write('async console line')
		await expect(transfer.flush()).rejects.toThrow('async stdout failure')
		expect(rejectionHandled).toBe(1)
		await expect(transfer.close()).resolves.toBeUndefined()
	})

	it('redacts complete escaped, malformed, identifier, and authorization values', async() => {
		const result = redactString(
			'password="prefix\\"secret-tail" userId=customer-12345 ' +
			'Authorization: Bearer short:secret!tail passwd=passwd-secret auth=auth-secret ' +
			'privateKey=private-secret session=session-secret malformedSecret="private-tail'
		)

		expect(result).not.toContain('prefix')
		expect(result).not.toContain('secret-tail')
		expect(result).not.toContain('customer-12345')
		expect(result).not.toContain('short:secret!tail')
		expect(result).not.toContain('private-tail')
		expect(result).not.toContain('passwd-secret')
		expect(result).not.toContain('auth-secret')
		expect(result).not.toContain('private-secret')
		expect(result).not.toContain('session-secret')
		expect(result.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(4)
		expect(redactFreeformValue({userId: 'customer-12345', email: 'person@example.com'}))
			.toEqual({userId: '[REDACTED]', email: '[REDACTED]'})

		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const record = await redacting({
			level: 'info', time: 0, message: 'structured identifiers',
			context: {attributes: {
				accountId: 'account-123', customerId: 'customer-123', tenantId: 'tenant-123',
				workspaceId: 'workspace-123', organizationId: 'organization-123', projectId: 'project-123',
				details: 'passwd=embedded-secret'
			}}
		})
		expect(Object.values(record.context?.attributes ?? {})).toEqual(Array(7).fill('***'))
	})

	it('redacts standalone provider credentials, credential URIs, and private keys across payload surfaces', async() => {
		const credentials = [
			'AKIAABCDEFGHIJKLMNOP',
			['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_'),
			'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			`sk-proj-${'a'.repeat(24)}`,
			`glpat-${'b'.repeat(20)}`,
			`SK${'a1'.repeat(16)}`,
			['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
			`AIza${'A'.repeat(35)}`,
			`npm_${'a'.repeat(36)}`,
			'postgresql://service:database-password@db.example.internal/app',
			'redis://:redis-password@cache.example.internal/0'
		]
		const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----'
		for (const credential of credentials) expect(redactString(`value ${credential}`)).not.toContain(credential)
		expect(redactString(`failure ${privateKey}`)).toBe('[REDACTED_PRIVATE_KEY]')

		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({
			level: 'error', time: 1,
			message: credentials.slice(0, 2).join(' '),
			context: {
				namespace: credentials[2],
				tags: [credentials[3] as string],
				attributes: Object.fromEntries(credentials.slice(4).map((credential, index) => [`value${index}`, credential]))
			},
			error: {details: privateKey}
		})
		const serialized = JSON.stringify(redacted)
		for (const credential of credentials) expect(serialized).not.toContain(credential)
		expect(serialized).not.toContain('private-key-body')
	})

	it('fails closed for boxed and binary secret containers', async() => {
		const credential = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_')
		const boxed = new String(credential)
		const binary = new TextEncoder().encode(credential)
		const admitted = copyLogAttributes({boxed, binary})
		expect(admitted).toEqual({boxed: '[Unserializable]', binary: '[Unserializable]'})

		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({
			level: 'error', time: 1, message: 'container boundary',
			context: {attributes: {boxed, binary}},
			error: {boxed, binary}
		})
		expect(redacted.context?.attributes).toEqual({boxed: '***', binary: '***'})
		expect(redacted.error).toEqual({
			boxed: '[REDACTED_UNSUPPORTED]', binary: '[REDACTED_UNSUPPORTED]'
		})

		const lines: string[] = []
		const logger = await createCustomLogging({
			clock, selfMetrics: false,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write: (line) => { lines.push(line) }}}},
			delivery: {mode: 'direct'}
		})
		logger.error('public container boundary', {boxed, binary} as never)
		await logger.flush()
		await logger.shutdown()
		expect(lines).toHaveLength(1)
		expect(lines[0]).not.toContain(credential)
		expect(JSON.parse(lines[0] as string).attributes).toMatchObject({
			boxed: '[Unserializable]', binary: '[Unserializable]'
		})
	})

	it('bounds wide-object enumeration at caller and provider admission boundaries', async() => {
		const createWideObject = () => {
			const keys = Array.from({length: 10_000}, (_, index) => `key_${index}`)
			let descriptorReads = 0
			const value = new Proxy(Object.create(null) as Record<string, unknown>, {
				ownKeys: () => keys,
				getOwnPropertyDescriptor: (_target, key) => {
					descriptorReads += 1
					return {value: `value_${String(key)}`, enumerable: true, configurable: true, writable: true}
				}
			})
			return {value, descriptorReads: () => descriptorReads}
		}

		const admission = createWideObject()
		const admitted = copyLogAttributes(admission.value)
		expect(admission.descriptorReads()).toBeLessThanOrEqual(2_001)
		expect(Object.keys(admitted ?? {})).toHaveLength(1_001)
		expect(admitted).not.toHaveProperty('key_1000')

		const providerPatch = createWideObject()
		const enriching = createDynamicProvidersEnriching([() => providerPatch.value])
		const result = await enriching({level: 'info', message: 'wide provider', time: 1}, {})
		expect(providerPatch.descriptorReads()).toBeLessThanOrEqual(2_003)
		expect(Object.keys(result.context?.attributes ?? {})).toHaveLength(1_001)
		expect(result.context?.attributes).not.toHaveProperty('key_1000')
	})

	it('redacts punctuation, invisible, and mixed-separator credential assignments', async() => {
		const privateValues = [
			'underscore-secret', 'dot-secret', 'slash-secret', 'zero-width-secret',
			'soft-hyphen-secret', 'bom-secret', 'space-secret', 'mixed-secret', 'api-secret'
		]
		const message = [
			'pass_word=underscore-secret',
			'pass.word=dot-secret',
			'pass/word=slash-secret',
			'pass\u200Bword=zero-width-secret',
			'pass\u00ADword=soft-hyphen-secret',
			'pass\uFEFFword=bom-secret',
			'pass  word=space-secret',
			'pass \u200B word=mixed-secret',
			'api \t key=api-secret'
		].join(' ')

		const redacted = redactString(message)
		for (const secret of privateValues) expect(redacted).not.toContain(secret)

		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const delivered = await redacting({
			level: 'error', time: 1, message,
			context: {attributes: {
				serviceAuth: 'structured-auth-secret',
				credentials: 'structured-credential-secret',
				serviceCredentialStatus: 'structured-status-secret',
				author: 'safe-author'
			}}
		})
		for (const secret of privateValues) expect(delivered.message).not.toContain(secret)
		expect(delivered.context?.attributes).toMatchObject({
			serviceAuth: '***', credentials: '***', serviceCredentialStatus: '***', author: 'safe-author'
		})
	})

	it('redacts compatibility Unicode credential names and secret-bearing keys', async() => {
		const message = 'ｐａｓｓｗｏｒｄ=fullwidth-message-secret'
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({
			level: 'error', time: 1, message,
			context: {attributes: {
				'ｐａｓｓｗｏｒｄ': 'fullwidth-value-secret',
				'ｔｏｋｅｎ=fullwidth-key-secret': 'safe'
			}},
			error: {'ｓｅｃｒｅｔ': 'fullwidth-error-secret'}
		})
		const serialized = JSON.stringify(redacted)

		expect(serialized).not.toContain('fullwidth-message-secret')
		expect(serialized).not.toContain('fullwidth-value-secret')
		expect(serialized).not.toContain('fullwidth-key-secret')
		expect(serialized).not.toContain('fullwidth-error-secret')
		expect(serialized).not.toContain('ｔｏｋｅｎ=')
	})

	it('redacts confusable and diacritic credential names across every payload surface', async() => {
		const message = [
			'passwоrd=cyrillic-message-secret', 'tóken=accent-message-secret',
			'passw0rd=leet-message-secret'
		].join(' ')
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({
			level: 'error', time: 1, message,
			context: {attributes: {
				'passwоrd': 'cyrillic-attribute-secret',
				'ѕecret': 'mixed-script-attribute-secret',
				't0ken': 'leet-attribute-secret',
				'tóken=accent-key-secret': 'safe'
			}},
			error: {'authοrization': 'greek-error-secret'}
		})
		const serialized = JSON.stringify(redacted)

		for (const secret of [
			'cyrillic-message-secret', 'accent-message-secret',
			'leet-message-secret', 'leet-attribute-secret',
			'cyrillic-attribute-secret', 'mixed-script-attribute-secret',
			'accent-key-secret', 'greek-error-secret'
		]) expect(serialized).not.toContain(secret)
	})

	it('bounds aggregate traversal across shared free-form diagnostic graphs', () => {
		let ownKeyReads = 0
		let value: unknown = 'password=shared-graph-secret'
		for (let depth = 0; depth < 6; depth += 1) {
			const child = value
			const target = Object.fromEntries(
				Array.from({length: 6}, (_, index) => [`branch${index}`, child])
			)
			value = new Proxy(target, {
				ownKeys(current) {
					ownKeyReads += 1
					return Reflect.ownKeys(current)
				}
			})
		}

		const redacted = redactFreeformValue(value)

		expect(ownKeyReads).toBeLessThanOrEqual(1_000)
		expect(JSON.stringify(redacted)).not.toContain('shared-graph-secret')
	})

	it('snapshots structured attributes at the redaction boundary', async() => {
		const details = {status: 'safe'}
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({
			level: 'info', time: 1, message: 'snapshot', context: {attributes: {details}}
		})

		;(details as Record<string, unknown>).password = 'post-redaction-attribute-secret'

		expect(redacted.context?.attributes?.details).not.toBe(details)
		expect(JSON.stringify(redacted)).not.toContain('post-redaction-attribute-secret')
	})

	it('snapshots free-form errors at the redaction boundary', async() => {
		const details = {status: 'safe'}
		const error = {details}
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({level: 'error', time: 1, message: 'snapshot', error})

		;(details as Record<string, unknown>).password = 'post-redaction-error-secret'

		expect(redacted.error).not.toBe(error)
		expect(JSON.stringify(redacted)).not.toContain('post-redaction-error-secret')
	})

	it('redacts secrets embedded in structured attribute keys', async() => {
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({
			level: 'info', time: 1, message: 'key boundary', context: {attributes: {
				'password=structured-key-secret': 'safe',
				'token_customer-structured-key-secret': 'safe',
				'user_id_12345': 'safe',
				'person@example.com': 'safe',
				password: 'structured-value-secret'
			}}
		})
		const serialized = JSON.stringify(redacted)

		expect(serialized).not.toContain('structured-key-secret')
		expect(serialized).not.toContain('12345')
		expect(serialized).not.toContain('person@example.com')
		expect(serialized).not.toContain('structured-value-secret')
		expect(redacted.context?.attributes).toMatchObject({password: '***'})
	})

	it('redacts every structured key when policy traversal falls back', async() => {
		const attributes = Object.create(null) as Record<string, unknown>
		Object.defineProperty(attributes, 'password=fallback-key-secret', {
			enumerable: true,
			get() { throw new Error('accessor denied') }
		})
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})

		const redacted = await redacting({
			level: 'info', time: 1, message: 'fallback key boundary', context: {attributes}
		})

		expect(JSON.stringify(redacted)).not.toContain('fallback-key-secret')
		expect(Object.keys(redacted.context?.attributes ?? {})).toEqual(['__redacted_key_0__'])
	})

	it('redacts secrets embedded in free-form error keys', async() => {
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})
		const redacted = await redacting({
			level: 'error', time: 1, message: 'key boundary', error: {
				'token=freeform-key-secret': 'safe',
				'token_customer-freeform-key-secret': 'safe',
				'user_id_67890': 'safe',
				'error-owner@example.com': 'safe',
				password: 'freeform-value-secret'
			}
		})
		const serialized = JSON.stringify(redacted)

		expect(serialized).not.toContain('freeform-key-secret')
		expect(serialized).not.toContain('67890')
		expect(serialized).not.toContain('error-owner@example.com')
		expect(serialized).not.toContain('freeform-value-secret')
	})

	it('does not expose function names or symbol descriptions after redaction', async() => {
		const callback = () => undefined
		Object.defineProperty(callback, 'name', {value: 'token=function-metadata-secret'})
		const marker = Symbol('password=symbol-metadata-secret')
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})

		const redacted = await redacting({
			level: 'error', time: 1, message: 'unsupported metadata',
			context: {attributes: {callback, marker}},
			error: {callback, marker}
		})
		const serialized = JSON.stringify(normalizeFormattingValue(redacted))

		expect(serialized).not.toContain('function-metadata-secret')
		expect(serialized).not.toContain('symbol-metadata-secret')
		expect(serialized).not.toContain('token=')
		expect(serialized).not.toContain('password=')
	})

	it('does not retain oversized structured or free-form property names', async() => {
		const oversizedKey = `oversized-${'x'.repeat(20_000)}`
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})

		const redacted = await redacting({
			level: 'error', time: 1, message: 'key size boundary',
			context: {attributes: {[oversizedKey]: 'safe'}},
			error: {[oversizedKey]: 'safe'}
		})
		const serialized = JSON.stringify(redacted)

		expect(serialized).not.toContain(oversizedKey)
		expect(serialized.length).toBeLessThan(1_000)
	})

	it('bounds structural policy traversal across repeated object graphs', async() => {
		let ownKeyReads = 0
		const leafTarget: Record<string, unknown> = {status: 'safe'}
		const leaf = new Proxy(leafTarget, {
			ownKeys(current) {
				ownKeyReads += 1
				return Reflect.ownKeys(current)
			}
		})
		const attributes = Object.fromEntries(
			Array.from({length: 1_000}, (_, index) => [`branch${index}`, leaf])
		)
		const redacting = createRedacting({policy: SAFE_DEFAULT_REDACTING_POLICY, budgets: {}})

		const redacted = await redacting({
			level: 'info', time: 1, message: 'bounded', context: {attributes}
		})
		leafTarget.password = 'post-redaction-secret'

		expect(ownKeyReads).toBe(1)
		expect(JSON.stringify(redacted)).not.toContain('post-redaction-secret')
	})

	it('bounds aggregate traversal across shared formatting graphs', () => {
		let ownKeyReads = 0
		let value: unknown = 'leaf'
		for (let depth = 0; depth < 7; depth += 1) {
			const child = value
			const target = Object.fromEntries(
				Array.from({length: 5}, (_, index) => [`branch${index}`, child])
			)
			value = new Proxy(target, {
				ownKeys(current) {
					ownKeyReads += 1
					return Reflect.ownKeys(current)
				}
			})
		}

		const normalized = normalizeFormattingValue(value)

		expect(ownKeyReads).toBeLessThanOrEqual(10_000)
		expect(JSON.stringify(normalized)).toContain('[MaxEntries]')
	})

	it('redacts dynamic provider names before reporting diagnostic context', async() => {
		const provider = () => { throw new Error('provider failed') }
		Object.defineProperty(provider, 'name', {value: 'token=provider-name-secret'})
		const report = vi.fn()
		const enriching = createDynamicProvidersEnriching([provider], {report} as never)

		await enriching({level: 'info', time: 1, message: 'provider boundary'})

		expect(report).toHaveBeenCalledOnce()
		expect(JSON.stringify(report.mock.calls[0]?.[1])).not.toContain('provider-name-secret')
	})

	it('bounds logger pipelines before a slow enricher can retain caller payloads', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const enriching = vi.fn(async(record) => { await gate; return record })
		const transferring: TransferringHandle = {
			write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry
		}
		const logger = createLogger(
			enriching, async(record) => record, () => 'line', transferring,
			clock, 'trace', 'json'
		)

		for (let index = 0; index < MAX_ACTIVE_LOG_PIPELINES + 1; index += 1) {
			logger.info(`retained-${index}`, {payload: {index}})
		}

		expect(logger.getStatus().droppedTotal).toBe(1)
		expect(enriching).not.toHaveBeenCalled()
		release()
		await logger.flush()
		expect(enriching).toHaveBeenCalledTimes(MAX_ACTIVE_LOG_PIPELINES)
		await logger.shutdown()
	})

	it('reserves log ownership before caller attributes can re-enter shutdown', async() => {
		const write = vi.fn()
		const transferring: TransferringHandle = {
			write,
			flush: vi.fn(async() => {}),
			close: vi.fn(async() => {}),
			telemetry
		}
		const logger = createLogger(
			async(record) => record,
			async(record) => record,
			() => 'reserved-line',
			transferring,
			clock,
			'trace',
			'json'
		)
		let shutdown: Promise<void> | undefined
		const attributes = new Proxy({safe: true}, {
			ownKeys(target) {
				shutdown ??= logger.shutdown()
				return Reflect.ownKeys(target)
			}
		})

		logger.info('must finish before shutdown', attributes)
		await expect(shutdown).resolves.toBeUndefined()

		expect(write).toHaveBeenCalledOnce()
		expect(logger.getStatus().state).toBe('closed')
	})

	it('bounds each caller payload before an asynchronous logger stage', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		let admittedRecord: unknown
		const enriching = vi.fn(async(record) => {
			admittedRecord = record
			await gate
			return record
		})
		const write = vi.fn()
		const logger = createLogger(
			enriching, async(record) => record, (record) => JSON.stringify(record),
			{write, flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry},
			clock, 'trace', 'json'
		)
		const nested = {payload: 'x'.repeat(1_000_000)}

		logger.info('m'.repeat(1_000_000), {nested} as never)
		await vi.waitFor(() => expect(enriching).toHaveBeenCalledOnce())
		nested.payload = 'mutated-after-admission'
		const retained = JSON.stringify(admittedRecord)

		expect(retained.length).toBeLessThan(60_000)
		expect(retained).not.toContain('mutated-after-admission')
		release()
		await logger.flush()
		await logger.shutdown()
	})

	it('keeps logger flush bounded to its call-time pipeline cutoff', async() => {
		let releaseFirst!: () => void
		let releaseSecond!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		const enriching = vi.fn(async(record) => {
			await (record.message === 'first' ? firstGate : secondGate)
			return record
		})
		const logger = createLogger(
			enriching, async(record) => record, () => 'line',
			{write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry},
			clock, 'trace', 'json'
		)

		const first = logger.info('first')
		await vi.waitFor(() => expect(enriching).toHaveBeenCalledOnce())
		let flushSettled = false
		const flush = logger.flush().finally(() => { flushSettled = true })
		const second = logger.info('second')
		releaseFirst()
		await first
		await vi.waitFor(() => expect(flushSettled).toBe(true))

		releaseSecond()
		await Promise.all([flush, second])
		await logger.shutdown()
	})

	it('holds a post-cutoff logger pipeline behind its physical flush', async() => {
		let releaseFirstEnrichment!: () => void
		let releaseSecondWrite!: () => void
		const firstEnrichmentGate = new Promise<void>((resolve) => { releaseFirstEnrichment = resolve })
		const secondWriteGate = new Promise<void>((resolve) => { releaseSecondWrite = resolve })
		const write = vi.fn(async(line: string) => {
			if (line === 'second') await secondWriteGate
		})
		const logger = createLogger(
			async(record) => {
				if (record.message === 'first') await firstEnrichmentGate
				return record
			},
			async(record) => record,
			(record) => record.message,
			createTransferring({sink: {write, flush: vi.fn(async() => {})}}),
			clock, 'trace', 'json'
		)

		const first = logger.info('first')
		await Promise.resolve()
		let flushSettled = false
		const flush = logger.flush().finally(() => { flushSettled = true })
		const second = logger.info('second')
		await Promise.resolve()
		expect(write).not.toHaveBeenCalledWith('second')
		releaseFirstEnrichment()
		await first
		await vi.waitFor(() => expect(flushSettled).toBe(true))
		expect(write).toHaveBeenCalledWith('second')

		releaseSecondWrite()
		await Promise.all([flush, second])
		await logger.shutdown()
	})

	it('drains a logger pipeline admitted behind an inherited flush before shutdown close', async() => {
		let releaseFirstFlush!: () => void
		const firstFlushGate = new Promise<void>((resolve) => { releaseFirstFlush = resolve })
		let releaseSecondFlush!: () => void
		const secondFlushGate = new Promise<void>((resolve) => { releaseSecondFlush = resolve })
		const events: string[] = []
		let flushCount = 0
		const logger = createLogger(
			async(record) => record,
			async(record) => record,
			(record) => record.message,
			{
				write: (line) => { events.push(`write:${line}`) },
				flush: async() => {
					flushCount += 1
					events.push(`flush-${flushCount}`)
					await (flushCount === 1 ? firstFlushGate : secondFlushGate)
				},
				close: async() => { events.push('close') },
				telemetry
			},
			clock, 'trace', 'json'
		)

		const flushing = logger.flush()
		await vi.waitFor(() => expect(events).toEqual(['flush-1']))
		const admitted = logger.info('behind-flush')
		await Promise.resolve()
		let shutdownSettled = false
		const shutdown = logger.shutdown().finally(() => { shutdownSettled = true })
		releaseFirstFlush()
		await flushing
		await vi.waitFor(() => expect(events).toEqual([
			'flush-1', 'write:behind-flush', 'flush-2'
		]))
		expect(shutdownSettled).toBe(false)
		expect(events).not.toContain('close')

		releaseSecondFlush()
		await Promise.all([admitted, shutdown])
		expect(events).toEqual(['flush-1', 'write:behind-flush', 'flush-2', 'close'])
	})

	it('keeps base transfer flush bounded to its call-time write cutoff', async() => {
		let releaseFirst!: () => void
		let releaseSecond!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		let writes = 0
		const transferring = createTransferring({sink: {write: async() => {
			writes += 1
			await (writes === 1 ? firstGate : secondGate)
		}}})

		transferring.write('first')
		let flushSettled = false
		const flush = transferring.flush().finally(() => { flushSettled = true })
		transferring.write('second')
		releaseFirst()
		await vi.waitFor(() => expect(flushSettled).toBe(true))

		releaseSecond()
		await flush
		await transferring.close()
	})

	it('does not run a post-cutoff base write concurrently with sink flush', async() => {
		let releaseFirst!: () => void
		let releaseSecond!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		let writes = 0
		let secondPending = false
		const flushSink = vi.fn(async() => {
			if (secondPending) throw new Error('sink flushed during post-cutoff write')
		})
		const transferring = createTransferring({sink: {
			write: async() => {
				writes += 1
				if (writes === 1) await firstGate
				else {
					secondPending = true
					await secondGate
					secondPending = false
				}
			},
			flush: flushSink
		}})

		transferring.write('first')
		const flush = transferring.flush()
		transferring.write('second')
		expect(writes).toBe(1)
		releaseFirst()
		await expect(flush).resolves.toBeUndefined()
		expect(flushSink).toHaveBeenCalledOnce()
		expect(writes).toBe(2)

		releaseSecond()
		await transferring.close()
	})

	it('keeps batched custom flush bounded to its call-time queue cutoff', async() => {
		let releaseFirst!: () => void
		let releaseSecond!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		let writes = 0
		const transferring = await createCustomTransferring(
			{write: async() => {
				writes += 1
				await (writes === 1 ? firstGate : secondGate)
			}},
			clock,
			{batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 5_000}}
		)

		transferring.write('first')
		await vi.waitFor(() => expect(writes).toBe(1))
		let flushSettled = false
		const flush = transferring.flush().finally(() => { flushSettled = true })
		transferring.write('second')
		releaseFirst()
		await vi.waitFor(() => expect(flushSettled).toBe(true))

		releaseSecond()
		await flush
		await transferring.close()
	})

	it('does not let disabled low-severity storms consume critical admission capacity', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const enriching = vi.fn(async(record) => { await gate; return record })
		const write = vi.fn()
		const logger = createLogger(
			enriching, async(record) => record, () => 'line',
			{write, flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry},
			clock, 'info', 'json'
		)

		for (let index = 0; index < MAX_ACTIVE_LOG_PIPELINES * 2; index += 1) {
			logger.debug(`disabled-${index}`)
		}
		logger.fatal('must-be-admitted')
		expect(logger.getStatus().droppedTotal).toBe(0)

		release()
		await logger.flush()
		expect(enriching).toHaveBeenCalledOnce()
		expect(write).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it('bounds direct remote deliveries by physical ownership', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const write = vi.fn(async() => { await gate })
		const transferring = await createCustomTransferring(
			{write}, clock, {retry: {
				maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
				jitter: 0, attemptTimeoutMs: 60_000
			}}
		)

		for (let index = 0; index < MAX_ACTIVE_DIRECT_DELIVERIES + 1; index += 1) {
			transferring.write(`line-${index}`)
		}

		expect(write).toHaveBeenCalledTimes(MAX_ACTIVE_DIRECT_DELIVERIES)
		expect(transferring.telemetry()).toMatchObject({
			queueSize: MAX_ACTIVE_DIRECT_DELIVERIES,
			droppedTotal: 1
		})
		release()
		await transferring.flush()
		expect(transferring.telemetry().queueSize).toBe(0)
		await transferring.close()
	})

	it('never closes fan-out children while an explicit flush still owns them', async() => {
		let releaseFlush!: () => void
		const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
		let flushPending = false
		const createChild = (): TransferringHandle => ({
			write: vi.fn(),
			flush: vi.fn(async() => {
				flushPending = true
				await flushGate
				flushPending = false
			}),
			close: vi.fn(async() => {
				if (flushPending) throw new Error('closed during active flush')
			}),
			telemetry
		})
		const stdout = createChild()
		const remote = createChild()
		const fanout = createFanoutTransferring({stdout, remote})

		const flush = fanout.flush()
		await vi.waitFor(() => expect(stdout.flush).toHaveBeenCalledOnce())
		const close = fanout.close()
		await Promise.resolve()

		expect(stdout.close).not.toHaveBeenCalled()
		expect(remote.close).not.toHaveBeenCalled()
		releaseFlush()
		await expect(Promise.all([flush, close])).resolves.toBeDefined()
		expect(stdout.close).toHaveBeenCalledOnce()
		expect(remote.close).toHaveBeenCalledOnce()
	})

	it('establishes both fan-out flush cutoffs before awaiting either child', async() => {
		let releaseStdout!: () => void
		let releaseRemoteWrite!: () => void
		const stdoutGate = new Promise<void>((resolve) => { releaseStdout = resolve })
		const remoteWriteGate = new Promise<void>((resolve) => { releaseRemoteWrite = resolve })
		const stdout: TransferringHandle = {
			write: vi.fn(), flush: vi.fn(async() => { await stdoutGate }),
			close: vi.fn(async() => {}), telemetry
		}
		const remoteWrite = vi.fn(async() => { await remoteWriteGate })
		const remote = createTransferring({sink: {write: remoteWrite, flush: vi.fn(async() => {})}})
		const fanout = createFanoutTransferring({stdout, remote})

		let flushSettled = false
		const flush = fanout.flush().finally(() => { flushSettled = true })
		fanout.write('post-cutoff')
		expect(remoteWrite).not.toHaveBeenCalled()
		releaseStdout()
		await vi.waitFor(() => expect(flushSettled).toBe(true))
		expect(remoteWrite).toHaveBeenCalledOnce()

		releaseRemoteWrite()
		await flush
		await fanout.close()
	})

	it('owns fan-out flush before a child can synchronously re-enter it', async() => {
		let fanout!: ReturnType<typeof createFanoutTransferring>
		let reentered = false
		const stdout = {
			write: vi.fn(),
			flush: vi.fn(async() => {
				if (!reentered) {
					reentered = true
					const nestedFlush = fanout.flush()
					const nestedClose = fanout.close()
					await Promise.all([nestedFlush, nestedClose])
				}
			}),
			close: vi.fn(async() => {}),
			telemetry
		}
		const remote = {
			write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry
		}
		fanout = createFanoutTransferring({stdout, remote})

		await expect(fanout.flush()).resolves.toBeUndefined()
		expect(stdout.flush).toHaveBeenCalledOnce()
		expect(remote.flush).toHaveBeenCalledOnce()
		await fanout.close()
	})

	it('owns fan-out close before a child can synchronously re-enter it', async() => {
		let fanout!: ReturnType<typeof createFanoutTransferring>
		let reentered = false
		const stdout = {
			write: vi.fn(), flush: vi.fn(async() => {}),
			close: vi.fn(async() => {
				if (!reentered) {
					reentered = true
					const nestedClose = fanout.close()
					const nestedFlush = fanout.flush()
					await Promise.all([nestedClose, nestedFlush])
				}
			}),
			telemetry
		}
		const remote = {
			write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry
		}
		fanout = createFanoutTransferring({stdout, remote})

		await expect(fanout.close()).resolves.toBeUndefined()
		expect(stdout.close).toHaveBeenCalledOnce()
		expect(remote.close).toHaveBeenCalledOnce()
	})

	it('starts independent fan-out child closes before either child settles', async() => {
		let releaseStdout!: () => void
		const stdoutGate = new Promise<void>((resolve) => { releaseStdout = resolve })
		const stdout: TransferringHandle = {
			write: vi.fn(), flush: vi.fn(async() => {}),
			close: vi.fn(async() => { await stdoutGate }), telemetry
		}
		const remote: TransferringHandle = {
			write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry
		}
		const fanout = createFanoutTransferring({stdout, remote})

		const close = fanout.close()
		await vi.waitFor(() => expect(remote.close).toHaveBeenCalledOnce())
		expect(stdout.close).toHaveBeenCalledOnce()

		releaseStdout()
		await expect(close).resolves.toBeUndefined()
	})

	it('contains synchronous base sink flush re-entry without self-awaiting', async() => {
		let transferring!: ReturnType<typeof createTransferring>
		const flush = vi.fn(async() => {
			const nestedFlush = transferring.flush()
			const nestedClose = transferring.close()
			await Promise.all([nestedFlush, nestedClose])
		})
		transferring = createTransferring({sink: {write: vi.fn(), flush}})

		const settled = await Promise.race([
			transferring.flush().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 50) })
		])

		expect(settled).toBe(true)
		expect(flush).toHaveBeenCalledOnce()
		await transferring.close()
	})

	it('contains asynchronous base sink flush re-entry without self-awaiting', async() => {
		let transferring!: ReturnType<typeof createTransferring>
		const flush = vi.fn(async() => {
			await Promise.resolve()
			const nestedFlush = transferring.flush()
			const nestedClose = transferring.close()
			await Promise.all([nestedFlush, nestedClose])
		})
		transferring = createTransferring({sink: {write: vi.fn(), flush}})

		const settled = await Promise.race([
			transferring.flush().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 50) })
		])

		expect(settled).toBe(true)
		expect(flush).toHaveBeenCalledOnce()
		await transferring.close()
	})

	it('contains synchronous base sink close re-entry without self-awaiting', async() => {
		let transferring!: ReturnType<typeof createTransferring>
		const close = vi.fn(async() => {
			const nestedClose = transferring.close()
			const nestedFlush = transferring.flush()
			await Promise.all([nestedClose, nestedFlush])
		})
		transferring = createTransferring({sink: {write: vi.fn(), close}})

		const settled = await Promise.race([
			transferring.close().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 50) })
		])

		expect(settled).toBe(true)
		expect(close).toHaveBeenCalledOnce()
	})

	it('contains asynchronous base sink close re-entry without self-awaiting', async() => {
		let transferring!: ReturnType<typeof createTransferring>
		const close = vi.fn(async() => {
			await Promise.resolve()
			const nestedClose = transferring.close()
			const nestedFlush = transferring.flush()
			await Promise.all([nestedClose, nestedFlush])
		})
		transferring = createTransferring({sink: {write: vi.fn(), close}})

		const settled = await Promise.race([
			transferring.close().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 50) })
		])

		expect(settled).toBe(true)
		expect(close).toHaveBeenCalledOnce()
	})

	it('does not suppress a detached transfer flush after its parent write settles', async() => {
		let transferring!: ReturnType<typeof createTransferring>
		let resolveDetached!: () => void
		const detached = new Promise<void>((resolve) => { resolveDetached = resolve })
		const flush = vi.fn(async() => {})
		const write = vi.fn(async() => {
			setTimeout(() => {
				void transferring.flush().finally(resolveDetached)
			}, 0)
		})
		transferring = createTransferring({sink: {write, flush}})

		transferring.write('owned')
		await transferring.flush()
		await detached

		expect(write).toHaveBeenCalledOnce()
		expect(flush).toHaveBeenCalledTimes(2)
		await transferring.close()
	})

	it('does not treat a stale detached scope as re-entry during unrelated active work', async() => {
		let transferring!: ReturnType<typeof createTransferring>
		let launchDetached!: () => void
		const detachedLaunch = new Promise<void>((resolve) => { launchDetached = resolve })
		let resolveDetached!: () => void
		const detached = new Promise<void>((resolve) => { resolveDetached = resolve })
		let releaseSecond!: () => void
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		const flush = vi.fn(async() => {})
		const write = vi.fn(async(line: string) => {
			if (line === 'first') {
				void detachedLaunch.then(async() => await transferring.flush()).finally(resolveDetached)
				return
			}
			await secondGate
		})
		transferring = createTransferring({sink: {write, flush}})

		transferring.write('first')
		await transferring.flush()
		transferring.write('second')
		await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
		let detachedSettled = false
		void detached.then(() => { detachedSettled = true })
		launchDetached()
		await Promise.resolve()
		expect(detachedSettled).toBe(false)

		releaseSecond()
		await detached
		expect(flush).toHaveBeenCalledTimes(2)
		await transferring.close()
	})

	it('propagates asynchronous lifecycle re-entry containment through a custom transfer wrapper', async() => {
		let transferring!: Awaited<ReturnType<typeof createCustomTransferring>>
		const flush = vi.fn(async() => {
			await Promise.resolve()
			const nestedFlush = transferring.flush()
			const nestedClose = transferring.close()
			await Promise.all([nestedFlush, nestedClose])
		})
		const close = vi.fn(async() => {
			await Promise.resolve()
			const nestedClose = transferring.close()
			const nestedFlush = transferring.flush()
			await Promise.all([nestedClose, nestedFlush])
		})
		transferring = await createCustomTransferring({write: vi.fn(), flush, close}, clock, {})

		await expect(transferring.flush()).resolves.toBeUndefined()
		await expect(transferring.close()).resolves.toBeUndefined()
		expect(flush).toHaveBeenCalled()
		expect(close).toHaveBeenCalledOnce()
	})

	it('contains asynchronous lifecycle re-entry from a direct custom sink write', async() => {
		let transferring!: Awaited<ReturnType<typeof createCustomTransferring>>
		const write = vi.fn(async() => {
			await Promise.resolve()
			await transferring.flush()
		})
		transferring = await createCustomTransferring({write}, clock, {})

		transferring.write('owned')
		const settled = await Promise.race([
			transferring.flush().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
		])

		expect(settled).toBe(true)
		expect(write).toHaveBeenCalledOnce()
		await transferring.close()
	})

	it('contains asynchronous lifecycle re-entry from a batched custom sink write', async() => {
		let transferring!: Awaited<ReturnType<typeof createCustomTransferring>>
		const write = vi.fn(async() => {
			await Promise.resolve()
			await transferring.flush()
		})
		transferring = await createCustomTransferring(
			{write},
			clock,
			{batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 5_000}}
		)

		transferring.write('owned')
		const settled = await Promise.race([
			transferring.flush().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
		])

		expect(settled).toBe(true)
		expect(write).toHaveBeenCalledOnce()
		await transferring.close()
	})

	it('propagates asynchronous lifecycle re-entry containment from a base child through fan-out', async() => {
		let fanout!: ReturnType<typeof createFanoutTransferring>
		const flush = vi.fn(async() => {
			await Promise.resolve()
			const nestedFlush = fanout.flush()
			const nestedClose = fanout.close()
			await Promise.all([nestedFlush, nestedClose])
		})
		const close = vi.fn(async() => {
			await Promise.resolve()
			const nestedClose = fanout.close()
			const nestedFlush = fanout.flush()
			await Promise.all([nestedClose, nestedFlush])
		})
		const stdout: TransferringHandle = {
			write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry
		}
		const remote = createTransferring({sink: {write: vi.fn(), flush, close}})
		fanout = createFanoutTransferring({stdout, remote})

		await expect(fanout.flush()).resolves.toBeUndefined()
		await expect(fanout.close()).resolves.toBeUndefined()
		expect(flush).toHaveBeenCalled()
		expect(close).toHaveBeenCalledOnce()
	})

	it('contains asynchronous public logger flush re-entry from a custom remote sink', async() => {
		let logger!: Awaited<ReturnType<typeof createCustomLogging>>
		const flush = vi.fn(async() => {
			await Promise.resolve()
			await logger.flush()
		})
		logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {
				write: vi.fn(), flush, close: vi.fn(async() => {})
			}}},
			delivery: {mode: 'direct', circuitBreaker: false},
			selfMetrics: false
		})
		logger.info('owned')

		const settled = await Promise.race([
			logger.flush().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
		])

		expect(settled).toBe(true)
		expect(flush).toHaveBeenCalled()
		await logger.shutdown()
	})

	it('contains asynchronous public logger shutdown re-entry from a custom remote sink', async() => {
		let logger!: Awaited<ReturnType<typeof createCustomLogging>>
		const close = vi.fn(async() => {
			await Promise.resolve()
			await logger.shutdown()
		})
		logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {
				write: vi.fn(), flush: vi.fn(async() => {}), close
			}}},
			delivery: {mode: 'direct', circuitBreaker: false},
			selfMetrics: false
		})

		const settled = await Promise.race([
			logger.shutdown().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
		])

		expect(settled).toBe(true)
		expect(close).toHaveBeenCalledOnce()
		expect(logger.getStatus().state).toBe('closed')
	})

	it('contains asynchronous logger flush re-entry from an enrichment provider', async() => {
		let logger!: Awaited<ReturnType<typeof createCustomLogging>>
		const provider = vi.fn(async() => {
			await Promise.resolve()
			await logger.flush()
			return {safe: true}
		})
		logger = await createCustomLogging({
			clock,
			providers: [provider],
			destinations: {stdout: false, remote: {provider: 'custom', sink: {
				write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {})
			}}},
			delivery: {mode: 'direct', circuitBreaker: false},
			selfMetrics: false
		})
		logger.info('owned')

		const settled = await Promise.race([
			logger.flush().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
		])

		expect(settled).toBe(true)
		expect(provider).toHaveBeenCalledOnce()
		await logger.shutdown()
	})

	it('does not suppress a detached logger flush after its provider pipeline settles', async() => {
		let logger!: Awaited<ReturnType<typeof createCustomLogging>>
		let launchDetached!: () => void
		const detachedLaunch = new Promise<void>((resolve) => { launchDetached = resolve })
		let resolveDetached!: () => void
		const detached = new Promise<void>((resolve) => { resolveDetached = resolve })
		const flush = vi.fn(async() => {})
		const provider = vi.fn(async() => {
			void detachedLaunch.then(async() => await logger.flush()).finally(resolveDetached)
			return {safe: true}
		})
		logger = await createCustomLogging({
			clock,
			providers: [provider],
			destinations: {stdout: false, remote: {provider: 'custom', sink: {
				write: vi.fn(), flush, close: vi.fn(async() => {})
			}}},
			delivery: {mode: 'direct', circuitBreaker: false},
			selfMetrics: false
		})
		logger.info('owned')

		await logger.flush()
		launchDetached()
		await detached

		expect(provider).toHaveBeenCalledOnce()
		expect(flush).toHaveBeenCalledTimes(2)
		await logger.shutdown()
	})

	it('preserves asynchronous public logger re-entry containment through the production remote wrapper', async() => {
		let logger!: ReturnType<typeof createLogger>
		const remoteFlush = vi.fn(async() => {
			await Promise.resolve()
			await logger.flush()
		})
		const stdout: TransferringHandle = {
			write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry
		}
		const transferring = await createProductionRemoteTransferring({
			stdout,
			remote: {write: vi.fn(), flush: remoteFlush, close: vi.fn(async() => {})},
			clock,
			selfMetrics: false
		})
		logger = createLogger(
			async(record) => record,
			async(record) => record,
			() => 'line',
			transferring,
			clock,
			'info',
			'json',
			undefined,
			undefined,
			false
		)
		logger.info('owned')

		const settled = await Promise.race([
			logger.flush().then(() => true),
			new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
		])

		expect(settled).toBe(true)
		expect(remoteFlush).toHaveBeenCalled()
		await logger.shutdown()
	})

	it('bounds base asynchronous transfers and retained failure ownership', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const write = vi.fn(async() => { await gate })
		const transferring = createTransferring({sink: {write}})

		for (let index = 0; index < MAX_ACTIVE_TRANSFERS + 1; index += 1) {
			transferring.write(`base-${index}`)
		}
		expect(write).toHaveBeenCalledTimes(MAX_ACTIVE_TRANSFERS)
		expect(transferring.telemetry()).toMatchObject({
			queueSize: MAX_ACTIVE_TRANSFERS,
			droppedTotal: 1
		})

		release()
		await transferring.flush()
		await transferring.close()
	})

	it('rejects synchronous base sink re-entry before active ownership is bypassed', async() => {
		let transferring!: ReturnType<typeof createTransferring>
		const write = vi.fn(() => { transferring.write('reentrant') })
		transferring = createTransferring({sink: {write}})

		transferring.write('outer')
		await transferring.flush()

		expect(write).toHaveBeenCalledOnce()
		expect(transferring.telemetry()).toMatchObject({writtenTotal: 1, droppedTotal: 1})
		await transferring.close()
	})

	it('pauses stdout writes behind one shared Node drain barrier', async() => {
		let drain!: () => void
		const write = vi.fn()
			.mockReturnValueOnce(false)
			.mockReturnValue(true)
		const stdout = {
			write,
			once: vi.fn((_event: string, callback: () => void) => { drain = callback; return stdout })
		}
		stubProcessStreams(stdout, {write: vi.fn(() => true), once: vi.fn()})
		const sink = consoleSink()
		const first = sink.write('{"level":"info","message":"first"}')
		const second = sink.write('{"level":"info","message":"second"}')

		expect(write).toHaveBeenCalledOnce()
		drain()
		await Promise.all([first, second])
		expect(write).toHaveBeenCalledTimes(2)
	})

	it.each(['error', 'close'] as const)(
		'releases a backpressured stdout write when the stream emits %s before drain',
		async(event) => {
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
			const stdout = {
				write: vi.fn(() => false),
				once: vi.fn((name: string, callback: (...args: unknown[]) => void) => {
					const callbacks = listeners.get(name) ?? new Set()
					callbacks.add(callback)
					listeners.set(name, callbacks)
					return stdout
				}),
				removeListener: vi.fn((name: string, callback: (...args: unknown[]) => void) => {
					listeners.get(name)?.delete(callback)
					return stdout
				})
			}
			stubProcessStreams(stdout, {
				write: vi.fn(() => true), once: vi.fn(), removeListener: vi.fn()
			})
			const sink = consoleSink()
			const write = Promise.resolve(sink.write('line'))
			const failure = new Error('stream failed')
			for (const callback of [...(listeners.get(event) ?? [])]) callback(failure)
			await expect(write).rejects.toThrow(event === 'error'
				? 'stream failed'
				: 'Logging stdout stream closed before backpressure drained')
			expect([...listeners.values()].every((callbacks) => callbacks.size === 0)).toBe(true)
		}
	)

	it('settles stdout backpressure even when listener cleanup throws', async() => {
		let drain!: () => void
		const stdout = {
			write: vi.fn(() => false),
			once: vi.fn((event: string, callback: () => void) => {
				if (event === 'drain') drain = callback
				return stdout
			}),
			removeListener: vi.fn(() => { throw new Error('cleanup failed') })
		}
		stubProcessStreams(stdout, {write: vi.fn(() => true), once: vi.fn()})
		const sink = consoleSink()
		const writing = sink.write('line')

		expect(() => drain()).not.toThrow()
		await expect(writing).resolves.toBeUndefined()
	})

	it('does not register terminal stdout listeners after synchronous drain', async() => {
		const stdout = {
			write: vi.fn(() => false),
			once: vi.fn((event: string, callback: () => void) => {
				if (event === 'drain') callback()
				return stdout
			}),
			removeListener: vi.fn(() => stdout)
		}
		stubProcessStreams(stdout, {write: vi.fn(() => true), once: vi.fn()})
		const sink = consoleSink()

		await expect(sink.write('line')).resolves.toBeUndefined()
		expect(stdout.once).toHaveBeenCalledTimes(1)
		expect(stdout.once).toHaveBeenCalledWith('drain', expect.any(Function))
	})

	it('contains multiline pretty attribute control sequences in TTY output', () => {
		stubProcessStreams(
			{isTTY: true, write: vi.fn(() => true), once: vi.fn()},
			{write: vi.fn(() => true), once: vi.fn()}
		)
		const result = formatPretty({
			level: 'info',
			time: 1,
			message: 'multiline attributes',
			context: {attributes: {
				payload: `${'x'.repeat(140)}\nFAKE ERROR\r\u001b[31mowned\tend`
			}}
		}, {mode: 'pretty'})

		expect(result).toContain('\\nFAKE ERROR\\rowned\\tend')
		expect(result).not.toContain('\nFAKE ERROR')
		expect(result).not.toContain('\u001b[31m')
	})

	it('contains Unicode line and bidi controls across pretty output fields', () => {
		stubProcessStreams(
			{isTTY: true, write: vi.fn(() => true), once: vi.fn()},
			{write: vi.fn(() => true), once: vi.fn()}
		)
		const controls = '\u0085\u2028\u2029\u202e\u2066\u2069'
		const result = formatPretty({
			level: 'info',
			time: 1,
			message: `message${controls}FAKE FATAL`,
			context: {
				namespace: `namespace${controls}`,
				tags: [`tag${controls}`],
				attributes: {
					[`key${controls}${'x'.repeat(140)}`]: `value${controls}`,
					nested: {value: `nested${controls}FAKE WARN`}
				}
			}
		}, {mode: 'pretty'})

		for (const control of controls) expect(result).not.toContain(control)
		expect(result).not.toContain('\u2028FAKE FATAL')
		expect(result).toContain('message������FAKE FATAL')
	})

	it('captures stdout transport methods against late rewiring', async() => {
		const initialWrite = vi.fn(() => true)
		const replacementWrite = vi.fn(() => true)
		const stdout = {write: initialWrite, once: vi.fn()}
		stubProcessStreams(stdout, {write: vi.fn(() => true), once: vi.fn()})
		const sink = consoleSink()
		stdout.write = replacementWrite

		await sink.write('captured')
		expect(initialWrite).toHaveBeenCalledWith('captured\n')
		expect(replacementWrite).not.toHaveBeenCalled()
	})

	it('bounds timed-out enrichment provider operations by physical ownership', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<Record<string, never>>((resolve) => { release = () => resolve({}) })
		const provider = vi.fn(() => gate)
		const enriching = createDynamicProvidersEnriching([provider])
		const operations = Array.from({length: MAX_ACTIVE_PROVIDER_OPERATIONS + 1}, (_, index) =>
			enriching({level: 'info', time: index, message: `provider-${index}`}))

		expect(provider).toHaveBeenCalledTimes(MAX_ACTIVE_PROVIDER_OPERATIONS)
		await vi.advanceTimersByTimeAsync(DYNAMIC_PROVIDER_TIMEOUT_MS)
		await Promise.all(operations)
		expect(provider).toHaveBeenCalledTimes(MAX_ACTIVE_PROVIDER_OPERATIONS)

		release()
		await vi.runAllTimersAsync()
		await enriching({level: 'info', time: 0, message: 'capacity-released'})
		expect(provider).toHaveBeenCalledTimes(MAX_ACTIVE_PROVIDER_OPERATIONS + 1)
	}, 15_000)

	it('reserves provider capacity before synchronous provider re-entry', async() => {
		let enriching!: ReturnType<typeof createDynamicProvidersEnriching>
		const provider = vi.fn((record) => enriching(record))
		enriching = createDynamicProvidersEnriching([provider])

		await expect(enriching({level: 'info', time: 1, message: 'reentrant'}))
			.resolves.toBeDefined()
		expect(provider).toHaveBeenCalledTimes(1)
	})

	it('keeps timed-out ambiguous direct work capacity-accounted until it settles', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const write = vi.fn(async() => { await gate })
		const transferring = await createCustomTransferring(
			{write}, clock, {retry: {
				maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
				jitter: 0, attemptTimeoutMs: 1
			}}
		)

		for (let index = 0; index < MAX_ACTIVE_DIRECT_DELIVERIES; index += 1) {
			transferring.write(`ambiguous-${index}`)
		}
		await vi.advanceTimersByTimeAsync(51)
		transferring.write('must-drop')

		expect(write).toHaveBeenCalledTimes(MAX_ACTIVE_DIRECT_DELIVERIES)
		expect(transferring.telemetry()).toMatchObject({
			queueSize: MAX_ACTIVE_DIRECT_DELIVERIES,
			droppedTotal: 1
		})
		release()
		await vi.runAllTimersAsync()
		await expect(transferring.flush()).resolves.toBeUndefined()
		await transferring.close()
	}, 30_000)

	it('does not hide an unrelated ambiguous failure behind pending physical work', async() => {
		vi.useFakeTimers()
		let releasePending!: () => void
		const pending = new Promise<void>((resolve) => { releasePending = resolve })
		const immediateFailure = Object.assign(new Error('independent ambiguous failure'), {
			ambiguousDelivery: true,
			nonRetryable: true
		})
		const write = vi.fn((line: string) => line === 'pending'
			? pending
			: Promise.reject(immediateFailure))
		const transferring = await createCustomTransferring(
			{write}, clock, {retry: {
				maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
				jitter: 0, attemptTimeoutMs: 1
			}}
		)

		transferring.write('pending')
		await vi.advanceTimersByTimeAsync(51)
		transferring.write('independent')
		await Promise.resolve()
		releasePending()
		await vi.runAllTimersAsync()

		await expect(transferring.flush()).rejects.toThrow('independent ambiguous failure')
		await transferring.close()
	})

	it('retains ownership of an abort-ignoring external sink operation', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const sink = snapshotExternalLoggingSink({write: async() => { await gate }})
		const controller = new AbortController()
		const operation = sink.write('line', {signal: controller.signal})
		controller.abort(new Error('deadline'))

		let settled = false
		void operation.then(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release()
		await expect(operation).resolves.toBeUndefined()
	})

	it('does not retain failed batched payloads in terminal diagnostics', async() => {
		const sinkFailure = Object.assign(new Error('batch unavailable'), {knownNoDelivery: true})
		const writeBatch = vi.fn().mockRejectedValue(sinkFailure)
		const transferring = await createCustomTransferring(
			{write: vi.fn(async() => {}), writeBatch},
			clock,
			{
				batching: {maxBatch: 1, maxBytes: 3_000_000, maxIntervalMs: 1_000},
				backpressure: {maxQueuedItems: 10, maxQueuedBytes: 4_000_000, onOverflow: 'drop-oldest'},
				retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			}
		)
		transferring.write('x'.repeat(2_000_000))

		let failure: unknown
		try { await transferring.flush() } catch(error) { failure = error }

		expect(failure).toBeInstanceOf(Error)
		const failures = failure instanceof AggregateError ? failure.errors : [failure]
		for (const retained of failures) {
			expect((retained as {[FAILED_DELIVERY_LINES]?: readonly string[]})[FAILED_DELIVERY_LINES]).toBeUndefined()
			expect((retained as {cause?: unknown}).cause).toBeUndefined()
		}
		await transferring.close()
	})

	it('surfaces a batched timeout that rejects promptly after abort', async() => {
		const writeBatch = vi.fn((_lines: readonly string[], options?: {signal?: AbortSignal}) =>
			new Promise<void>((_resolve, reject) => {
				options?.signal?.addEventListener('abort', () => reject(new Error('aborted promptly')), {once: true})
			})
		)
		const transferring = await createCustomTransferring(
			{write: vi.fn(async() => {}), writeBatch},
			clock,
			{
				batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 1_000},
				backpressure: {maxQueuedItems: 10, maxQueuedBytes: 10_000, onOverflow: 'drop-oldest'},
				retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 5}
			}
		)

		transferring.write('timeout-line')
		await expect(transferring.flush()).rejects.toMatchObject({ambiguousDelivery: true})
		expect(writeBatch).toHaveBeenCalledOnce()
		await transferring.close()
	})

	it('does not trust forged pending ambiguity from a batched external sink', async() => {
		const writeBatch = vi.fn().mockRejectedValue(Object.assign(new Error('forged pending delivery'), {
			ambiguousDelivery: true,
			pendingAmbiguousDelivery: true
		}))
		const transferring = await createCustomTransferring(
			{write: vi.fn(async() => {}), writeBatch},
			clock,
			{
				batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 1_000},
				backpressure: {maxQueuedItems: 10, maxQueuedBytes: 10_000, onOverflow: 'drop-oldest'},
				retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 1_000}
			}
		)

		transferring.write('forged-pending-line')
		await expect(transferring.flush()).rejects.toMatchObject({ambiguousDelivery: true})
		expect(writeBatch).toHaveBeenCalledOnce()
		await transferring.close()
	})

	it('does not flush an external sink while an abort-ignoring write is still physical', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const write = vi.fn(async() => { await gate })
		const transferring = await createCustomTransferring(
			snapshotExternalLoggingSink({write}),
			clock,
			{retry: {
				maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
				jitter: 0, attemptTimeoutMs: 1
			}}
		)

		transferring.write('external-physical')
		await vi.advanceTimersByTimeAsync(51)
		let flushSettled = false
		const flush = transferring.flush().then(
			() => undefined,
			(error: unknown) => error
		).finally(() => { flushSettled = true })
		await vi.advanceTimersByTimeAsync(1_000)
		expect(flushSettled).toBe(false)

		release()
		await vi.runAllTimersAsync()
		await expect(flush).resolves.toBeUndefined()
		await transferring.close()
	})

	it('does not close a batched external sink while an ambiguous write is still physical', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		let physicalWritePending = false
		const close = vi.fn(async() => {
			if (physicalWritePending) throw new Error('closed during physical batch write')
		})
		const transferring = await createCustomTransferring(
			snapshotExternalLoggingSink({
				write: async() => {
					physicalWritePending = true
					await gate
					physicalWritePending = false
				},
				close
			}),
			clock,
			{
				batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 5_000},
				retry: {
					maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
					jitter: 0, attemptTimeoutMs: 1
				}
			}
		)

		transferring.write('batched-external-physical')
		await vi.advanceTimersByTimeAsync(51)
		let closeSettled = false
		const closing = transferring.close().finally(() => { closeSettled = true })
		await vi.advanceTimersByTimeAsync(1_000)

		expect(closeSettled).toBe(false)
		expect(close).not.toHaveBeenCalled()
		release()
		await vi.runAllTimersAsync()
		await expect(closing).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledOnce()
	})

	it('never closes transfer while a timed-out physical flush still owns it', async() => {
		vi.useFakeTimers()
		let releaseFlush!: () => void
		const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
		const close = vi.fn(async() => {})
		const transferring: TransferringHandle = {
			write: vi.fn(), flush: vi.fn(async() => { await flushGate }), close, telemetry
		}
		const logger = createLogger(
			async(record) => record, async(record) => record, () => 'line', transferring,
			clock, 'trace', 'json', undefined, undefined, undefined, undefined, undefined,
			{flushTimeoutMs: 1, shutdownTimeoutMs: 100}
		)

		const firstShutdown = logger.shutdown()
		const rejection = expect(firstShutdown).rejects.toThrow('logging flush timed out')
		await vi.advanceTimersByTimeAsync(1)
		await rejection
		expect(close).not.toHaveBeenCalled()

		releaseFlush()
		await vi.runAllTimersAsync()
		await expect(logger.shutdown()).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledOnce()
	})

	it.each(['http', 'loki'] as const)(
		'captures %s transport globals when the sink is constructed',
		async(provider) => {
			const initialFetch = vi.fn().mockResolvedValue({ok: true, status: 200})
			const replacementFetch = vi.fn().mockResolvedValue({ok: true, status: 200})
			vi.stubGlobal('fetch', initialFetch)
			const sink = provider === 'http'
				? httpSink('https://logs.example.com')
				: createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
			vi.stubGlobal('fetch', replacementFetch)
			vi.stubGlobal('AbortController', class {
				constructor() { throw new Error('late transport replacement') }
			})

			await expect(sink.write('{"time":1,"level":"info","message":"safe"}'))
				.resolves.toBeUndefined()
			expect(initialFetch).toHaveBeenCalledOnce()
			expect(replacementFetch).not.toHaveBeenCalled()
		}
	)

	it.each(['http', 'loki'] as const)(
		'omits sensitive endpoint paths from %s failure diagnostics',
		async(provider) => {
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
			const secret = 'signed-endpoint-path-secret'
			const sink = provider === 'http'
				? httpSink(`https://logs.example.com/webhooks/${secret}`)
				: createLokiLoggingSink({
					provider: 'loki', url: `https://logs.example.com/tenant/${secret}`
				})

			const outcome = await Promise.allSettled([sink.write('safe')])
			const message = outcome[0]?.status === 'rejected'
				? String((outcome[0].reason as Error).message) : ''

			expect(message).not.toContain(secret)
			expect(message).toContain('https://logs.example.com')
		}
	)

	it.each(['http', 'loki'] as const)(
		'rejects oversized or accessor-backed %s payloads before fetch',
		async(provider) => {
			const fetchRequest = vi.fn().mockResolvedValue(new Response(null, {status: 204}))
			vi.stubGlobal('fetch', fetchRequest)
			const sink = provider === 'http'
				? httpSink('https://logs.example.com')
				: createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
			const accessorLines: string[] = []
			Object.defineProperty(accessorLines, '0', {
				enumerable: true,
				get() { return 'caller-controlled' }
			})
			Object.defineProperty(accessorLines, 'length', {value: 1})

			await expect(sink.write('x'.repeat(10_000_001))).rejects.toMatchObject({
				code: provider === 'http' ? 'HTTP_BAD_REQUEST' : 'LOKI_BAD_REQUEST',
				knownNoDelivery: true,
				retryable: false
			})
			await expect(sink.writeBatch?.(accessorLines)).rejects.toMatchObject({
				code: provider === 'http' ? 'HTTP_BAD_REQUEST' : 'LOKI_BAD_REQUEST',
				knownNoDelivery: true,
				retryable: false
			})
			expect(fetchRequest).not.toHaveBeenCalled()
		}
	)

	it.each(['http', 'loki'] as const)(
		'propagates asynchronous %s fetch lifecycle re-entry containment through base and fan-out',
		async(provider) => {
			let fanout!: ReturnType<typeof createFanoutTransferring>
			const fetchRequest = vi.fn(async() => {
				await Promise.resolve()
				const nestedFlush = fanout.flush()
				const nestedClose = fanout.close()
				await Promise.all([nestedFlush, nestedClose])
				return new Response(null, {status: 204})
			})
			vi.stubGlobal('fetch', fetchRequest)
			const sink = provider === 'http'
				? httpSink('https://logs.example.com')
				: createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
			const remote = createTransferring({sink})
			const stdout: TransferringHandle = {
				write: vi.fn(), flush: vi.fn(async() => {}), close: vi.fn(async() => {}), telemetry
			}
			fanout = createFanoutTransferring({stdout, remote})

			fanout.write('{"time":1,"level":"info","message":"safe"}')
			const settled = await Promise.race([
				fanout.flush().then(() => true),
				new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
			])

			expect(settled).toBe(true)
			expect(fetchRequest).toHaveBeenCalledOnce()
			await expect(fanout.close()).resolves.toBeUndefined()
		}
	)

	it.each(['http', 'loki'] as const)(
		'bounds physical %s requests even when fetch ignores AbortSignal',
		async(provider) => {
			vi.useFakeTimers()
			const releases: Array<(response: Response) => void> = []
			const physicalRequests: Array<Promise<Response>> = []
			const fetchRequest = vi.fn(() => {
				const request = new Promise<Response>((resolve) => { releases.push(resolve) })
				physicalRequests.push(request)
				return request
			})
			vi.stubGlobal('fetch', fetchRequest)
			const sink = provider === 'http'
				? httpSink('https://logs.example.com', {timeoutMs: 5})
				: createLokiLoggingSink({
					provider: 'loki', url: 'https://logs.example.com', requestTimeoutMs: 5
				})
			const outcomesPromise = Promise.allSettled(
				Array.from({length: MAX_ACTIVE_REMOTE_REQUESTS}, () =>
					sink.write('{"time":1,"level":"info","message":"safe"}'))
			)

			await vi.advanceTimersByTimeAsync(5)
			const outcomes = await outcomesPromise
			expect(outcomes).toHaveLength(MAX_ACTIVE_REMOTE_REQUESTS)
			for (const outcome of outcomes) {
				expect(outcome).toMatchObject({
					status: 'rejected',
					reason: {
						code: provider === 'http' ? 'HTTP_TIMEOUT' : 'LOKI_TIMEOUT',
						ambiguousDelivery: true,
						nonRetryable: true
					}
				})
			}

			await expect(sink.write('capacity')).rejects.toMatchObject({
				code: provider === 'http' ? 'HTTP_NETWORK' : 'LOKI_NETWORK',
				knownNoDelivery: true,
				retryable: false
			})
			expect(fetchRequest).toHaveBeenCalledTimes(MAX_ACTIVE_REMOTE_REQUESTS)
			let flushSettled = false
			const flush = Promise.resolve(sink.flush?.()).then(() => { flushSettled = true })
			await Promise.resolve()
			expect(flushSettled).toBe(false)

			for (const release of releases) {
				release(new Response(null, {status: 204}))
			}
			await Promise.all(physicalRequests)
			await flush

			const recovered = sink.write('capacity-recovered')
			const recoveredOutcome = expect(recovered).resolves.toBeUndefined()
			await Promise.resolve()
			expect(fetchRequest).toHaveBeenCalledTimes(MAX_ACTIVE_REMOTE_REQUESTS + 1)
			let closeSettled = false
			const close = Promise.resolve(sink.close?.()).then(() => { closeSettled = true })
			await Promise.resolve()
			expect(closeSettled).toBe(false)
			await expect(sink.write('after-close-started')).rejects.toMatchObject({
				code: provider === 'http' ? 'HTTP_NETWORK' : 'LOKI_NETWORK',
				knownNoDelivery: true
			})
			expect(fetchRequest).toHaveBeenCalledTimes(MAX_ACTIVE_REMOTE_REQUESTS + 1)
			releases.at(-1)?.(new Response(null, {status: 204}))
			await recoveredOutcome
			await close
		}
	)

	it.each(['http', 'loki'] as const)(
		'keeps %s flush bounded to its call-time request cutoff',
		async(provider) => {
			const releases: Array<(response: Response) => void> = []
			vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve) })))
			const sink = provider === 'http'
				? httpSink('https://logs.example.com')
				: createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
			const first = sink.write('{"time":1,"level":"info","message":"first"}')
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			let flushSettled = false
			const flush = Promise.resolve(sink.flush?.()).finally(() => { flushSettled = true })
			const second = sink.write('{"time":2,"level":"info","message":"second"}')
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			releases[0]?.(new Response(null, {status: 204}))
			await first
			await vi.waitFor(() => expect(flushSettled).toBe(true))

			releases[1]?.(new Response(null, {status: 204}))
			await Promise.all([flush, second])
			await sink.close?.()
		}
	)

	it.each(['http', 'loki'] as const)(
		'does not turn successful %s delivery into failure when signal cleanup throws',
		async(provider) => {
			vi.stubGlobal('fetch', vi.fn(async() => new Response(null, {status: 204})))
			const signal = {
				aborted: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(() => { throw new Error('signal cleanup failed') })
			} as unknown as AbortSignal
			const sink = provider === 'http'
				? httpSink('https://logs.example.com')
				: createLokiLoggingSink({provider: 'loki', url: 'https://logs.example.com'})
			const line = '{"time":1,"level":"info","message":"delivered"}'

			await expect(sink.write(line, {signal})).resolves.toBeUndefined()
			expect(signal.removeEventListener).toHaveBeenCalledOnce()
			await sink.close?.()
		}
	)

	it('contains asynchronous base-sink close re-entry without abandoning the admitted write', async() => {
		let releaseWrite!: () => void
		const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
		const closeSink = vi.fn(async() => {})
		let transferring!: TransferringHandle
		const writeSink = vi.fn(async() => {
			await Promise.resolve()
			await transferring.close()
			await writeGate
		})
		transferring = createTransferring({
			sink: {write: writeSink, flush: vi.fn(async() => {}), close: closeSink}, clock
		})

		transferring.write('owned')
		await Promise.resolve()
		expect(closeSink).not.toHaveBeenCalled()
		let closeSettled = false
		const closing = transferring.close().finally(() => { closeSettled = true })
		await Promise.resolve()
		expect(closeSettled).toBe(false)
		expect(closeSink).not.toHaveBeenCalled()

		releaseWrite()
		await closing
		expect(writeSink).toHaveBeenCalledOnce()
		expect(closeSink).toHaveBeenCalledOnce()
	})

	it('drains and flushes a write admitted behind an existing flush before base close', async() => {
		let releaseFirstFlush!: () => void
		const firstFlushGate = new Promise<void>((resolve) => { releaseFirstFlush = resolve })
		let releaseWrite!: () => void
		const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
		const events: string[] = []
		let flushCount = 0
		const transferring = createTransferring({
			sink: {
				write: async() => { events.push('write'); await writeGate },
				flush: async() => {
					flushCount += 1
					events.push(`flush-${flushCount}`)
					if (flushCount === 1) await firstFlushGate
				},
				close: async() => { events.push('close') }
			},
			clock
		})

		const flushing = transferring.flush()
		await vi.waitFor(() => expect(events).toEqual(['flush-1']))
		transferring.write('queued-behind-flush')
		let closeSettled = false
		const closing = transferring.close().finally(() => { closeSettled = true })
		releaseFirstFlush()
		await flushing
		await vi.waitFor(() => expect(events).toEqual(['flush-1', 'write']))
		expect(closeSettled).toBe(false)
		expect(events).not.toContain('close')

		releaseWrite()
		await closing
		expect(events).toEqual(['flush-1', 'write', 'flush-2', 'close'])
	})
})
