/**
 * @file Tests for timeout engine cancellation behavior.
 */

import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createTimeoutEngine} from '../../../src/resilience/core/timeout'

describe('timeout-engine', () => {
	it('propagates AbortSignal cancellation distinctly from timeout expiry', async() => {
		const clock = createFixedClock(1000)
		const timeout = createTimeoutEngine({clock})
		const controller = new AbortController()
		const context = {
			resource: 'api.test',
			operationKind: 'external.http' as const,
			tenantId: 'tenant-1',
			workspaceId: 'workspace-1',
			userId: 'user-1',
			correlationId: 'correlation-1',
			metadata: {source: 'timeout-test'}
		}

		const operation = vi.fn(
			async(signal: AbortSignal) => {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener('abort', () => {
						const error = new Error('aborted')
						error.name = 'AbortError'
						reject(error)
					}, {once: true})
				})
				return 'never'
			}
		)
		const pending = timeout.withTimeout(
			operation,
			1000,
			context,
			{parentSignal: controller.signal}
		)

		controller.abort()

		await expect(pending).rejects.toMatchObject({
			name: 'AbortError',
			code: 'ABORT_ERR'
		})
		expect(operation).not.toHaveBeenCalled()
	})

	it('handles invalid timeouts, timeout expiry, successful completion, and original errors', async() => {
		const clock = createFixedClock(500)
		const timeout = createTimeoutEngine({clock})
		const coerce = vi.fn(() => 1)
		await expect(timeout.withTimeout(async() => 'ok', {[Symbol.toPrimitive]: coerce} as never, {
			resource: 'api.test', operationKind: 'external.http'
		})).rejects.toThrow(/Timeout/u)
		expect(coerce).not.toHaveBeenCalled()

		await expect(timeout.withTimeout(async() => 'ok', 0, {
			resource: 'api.test',
			operationKind: 'external.http'
		})).rejects.toThrow(/timeout must be > 0/i)
		await expect(timeout.withTimeout(async() => 'ok', Number.POSITIVE_INFINITY, {
			resource: 'api.test',
			operationKind: 'external.http'
		})).rejects.toThrow(/timeout must be > 0/i)
		await expect(timeout.withTimeout(async() => 'ok', 2_147_483_648, {
			resource: 'api.test',
			operationKind: 'external.http'
		})).rejects.toThrow(/2147483647/i)

		const expired = timeout.withTimeout(async(signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
			})
			return 'never'
		}, 5, {
			resource: 'api.test',
			operationKind: 'external.http'
		})
		await expect(expired).rejects.toMatchObject({name: 'TimedOutError', context: {resource: 'api.test'}})

		await expect(timeout.withTimeout(async() => {
			await new Promise((resolve) => setTimeout(resolve, 25))
			return 'late-success'
		}, 5, {
			resource: 'api.test',
			operationKind: 'external.http'
		})).rejects.toMatchObject({name: 'TimedOutError'})

		const ignoredParent = new AbortController()
		const ignoredParentAbort = timeout.withTimeout(async() => {
			await new Promise((resolve) => setTimeout(resolve, 25))
			return 'late-success'
		}, 50, {
			resource: 'api.test',
			operationKind: 'external.http'
		}, {
			parentSignal: ignoredParent.signal
		})
		ignoredParent.abort()
		await expect(ignoredParentAbort).rejects.toMatchObject({name: 'AbortError', code: 'ABORT_ERR'})

		const parent = new AbortController()
		parent.abort()
		const operation = vi.fn(async(signal: AbortSignal) => {
			if (signal.aborted) {
				throw Object.assign(new Error('already aborted'), {name: 'AbortError'})
			}
			return 'never'
		})
		await expect(timeout.withTimeout(operation, 20, {
			resource: 'api.test',
			operationKind: 'external.http'
		}, {
			parentSignal: parent.signal
		})).rejects.toMatchObject({name: 'AbortError', code: 'ABORT_ERR'})
		expect(operation).not.toHaveBeenCalled()

		await expect(timeout.withTimeout(async() => 'ok', 20, {
			resource: 'api.test',
			operationKind: 'external.http'
		})).resolves.toBe('ok')

		await expect(timeout.withTimeout(async() => {
			throw new Error('boom')
		}, 20, {
			resource: 'api.test',
			operationKind: 'external.http'
		})).rejects.toThrow('boom')

		await expect(timeout.withTimeout(async() => {
			const aborted = Object.assign(new Error('manual abort'), {name: 'AbortError'})
			throw aborted
		}, 20, {
			resource: 'api.test',
			operationKind: 'external.http'
		})).rejects.toMatchObject({
			name: 'AbortError',
			message: 'manual abort'
		})

		expect(() => timeout.destroy()).not.toThrow()
	})

	it('does not let synchronous abort cleanup turn an authoritative timeout into success', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		const context = {resource: 'api.test', operationKind: 'external.http' as const}

		await expect(timeout.withTimeout(
			(signal) => new Promise<string>((resolve) => {
				signal.addEventListener('abort', () => resolve('cleanup-complete'), {once: true})
			}),
			5,
			context
		)).rejects.toMatchObject({name: 'TimedOutError'})

		const controller = new AbortController()
		const cancelled = timeout.withTimeout(
			(signal) => new Promise<string>((resolve) => {
				signal.addEventListener('abort', () => resolve('cleanup-complete'), {once: true})
			}),
			50,
			context,
			{parentSignal: controller.signal}
		)
		controller.abort()

		await expect(cancelled).rejects.toMatchObject({name: 'AbortError', code: 'ABORT_ERR'})
	})

	it('does not let timeout-triggered cleanup relabel the timeout as parent cancellation', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		const parent = new AbortController()

		await expect(timeout.withTimeout(
			(signal) => new Promise<never>((_resolve, reject) => {
				signal.addEventListener('abort', () => {
					parent.abort()
					reject(new Error('cleanup aborted'))
				}, {once: true})
			}),
			5,
			{resource: 'timeout-authority', operationKind: 'external.http'},
			{parentSignal: parent.signal}
		)).rejects.toMatchObject({name: 'TimedOutError', code: 'RESILIENCE_TIMEOUT'})
		expect(parent.signal.aborted).toBe(true)
	})

	it('does not let a settlement observer relabel completed work as cancellation', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		const parent = new AbortController()
		const afterSettlement = (settled: Promise<void>) => {
			void settled.then(() => parent.abort())
		}

		await expect(timeout.withTimeout(
			async() => 'committed',
			100,
			{resource: 'completion-authority', operationKind: 'db.write'},
			{parentSignal: parent.signal, onOperationSettled: afterSettlement}
		)).resolves.toBe('committed')
		expect(parent.signal.aborted).toBe(true)

		const failure = new Error('provider failed')
		const secondParent = new AbortController()
		await expect(timeout.withTimeout(
			async() => { throw failure },
			100,
			{resource: 'failure-authority', operationKind: 'db.write'},
			{parentSignal: secondParent.signal, onOperationSettled: (settled) => {
				void settled.then(() => secondParent.abort())
			}}
		)).rejects.toBe(failure)
		expect(secondParent.signal.aborted).toBe(true)
	})

	it('rejects through the wrapper when the clock fails inside an async timeout callback', async() => {
		let reads = 0
		const timeout = createTimeoutEngine({
			clock: {
				now: () => {
					if (reads++ === 0) return 500
					throw new Error('clock unavailable')
				}
			}
		})

		await expect(timeout.withTimeout(
			async() => await new Promise<never>(() => undefined),
			5,
			{resource: 'api.test', operationKind: 'external.http'}
		)).rejects.toThrow('clock unavailable')
	})

	it('does not traverse hostile rejection prototypes after timeout', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		let prototypeReads = 0
		let hostile: object
		hostile = new Proxy({}, {getPrototypeOf: () => { prototypeReads++; return hostile }})
		await expect(timeout.withTimeout(
			async(signal) => await new Promise<never>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(hostile), {once: true})
			}),
			5,
			{resource: 'api.test', operationKind: 'external.http'}
		)).rejects.toMatchObject({code: 'RESILIENCE_TIMEOUT'})
		expect(prototypeReads).toBe(0)
	})

	it('does not execute hostile context accessors while constructing timeout errors', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		const resourceGetter = vi.fn(() => 'secret.resource')
		const context = Object.defineProperty({operationKind: 'external.http'}, 'resource', {
			enumerable: true,
			get: resourceGetter
		})
		let failure: unknown
		try {
			await timeout.withTimeout(async() => await new Promise<never>(() => undefined), 5, context as never)
		} catch(error) {
			failure = error
		}
		expect(resourceGetter).not.toHaveBeenCalled()
		expect(failure).toMatchObject({code: 'RESILIENCE_TIMEOUT', context: {resource: 'unknown'}})
	})

	it('does not start protected work when timer scheduling fails', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		const operation = vi.fn(async() => 'side effect')
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
			throw new Error('timer scheduling failed')
		})
		await expect(timeout.withTimeout(operation, 10, {
			resource: 'api.test', operationKind: 'external.http'
		})).rejects.toThrow('timer scheduling failed')
		timer.mockRestore()
		await Promise.resolve()
		expect(operation).not.toHaveBeenCalled()
	})

	it('does not replace a protected result when timer cleanup fails', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(0)})
		const nativeClearTimeout = globalThis.clearTimeout
		const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
			nativeClearTimeout(timer)
			throw new Error('timer cleanup failed')
		})

		await expect(timeout.withTimeout(async() => 'ok', 10, {
			resource: 'cleanup.test',
			operationKind: 'external.http'
		})).resolves.toBe('ok')
		clear.mockRestore()
	})

	it('captures the clock method so later capability rewiring cannot break execution', async() => {
		const mutableClock = {now: () => 500}
		const timeout = createTimeoutEngine({clock: mutableClock})
		mutableClock.now = () => { throw new Error('rewired clock') }

		await expect(timeout.withTimeout(
			async() => 'ok',
			20,
			{resource: 'api.test', operationKind: 'external.http'}
		)).resolves.toBe('ok')
	})

	it('rolls back a parent listener when installation throws after attaching it', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		let retained: (() => void) | undefined
		const parentSignal = {
			aborted: false,
			addEventListener: (_type: string, listener: () => void) => {
				retained = listener
				throw new Error('install failed after attach')
			},
			removeEventListener: (_type: string, listener: () => void) => {
				if (retained === listener) retained = undefined
			}
		} as unknown as AbortSignal

		await expect(timeout.withTimeout(
			async() => 'must-not-run',
			20,
			{resource: 'api.test', operationKind: 'external.http'},
			{parentSignal}
		)).rejects.toThrow('install failed after attach')
		expect(retained).toBeUndefined()
	})

	it('snapshots timeout options without executing a shape-shifting signal accessor', async() => {
		const timeout = createTimeoutEngine({clock: createFixedClock(500)})
		const operation = vi.fn(async() => 'must-not-run')
		let reads = 0
		const options = Object.defineProperty({}, 'parentSignal', {
			enumerable: true,
			get: () => {
				reads++
				return new AbortController().signal
			}
		})

		await expect(timeout.withTimeout(operation, 20, {
			resource: 'options.race', operationKind: 'external.http'
		}, options as never)).rejects.toThrow(/plain data object/u)
		expect(reads).toBe(0)
		expect(operation).not.toHaveBeenCalled()
	})

	it('rechecks parent cancellation after publishing the listener', async() => {
		let reads = 0
		const operation = vi.fn(async() => 'must not start')
		const signal = {
			get aborted() { return ++reads > 1 },
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		} as unknown as AbortSignal
		const timeout = createTimeoutEngine({clock: createFixedClock(0)})

		await expect(timeout.withTimeout(operation, 100, {
			resource: 'cancellation.race', operationKind: 'external.http'
		}, {parentSignal: signal})).rejects.toMatchObject({name: 'AbortError', code: 'ABORT_ERR'})
		expect(operation).not.toHaveBeenCalled()
	})
})
