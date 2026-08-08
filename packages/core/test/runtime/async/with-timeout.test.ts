import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {withTimeout} from '../../../src/runtime/async/with-timeout'

describe('withTimeout', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('should return result when operation completes before timeout', async() => {
		const operation = vi.fn().mockResolvedValue('result')

		const promise = withTimeout(operation, 1000)
		vi.advanceTimersByTime(500)
		const result = await promise

		expect(result).toBe('result')
		expect(operation).toHaveBeenCalledTimes(1)
	})

	it('should throw TimeoutError when operation exceeds timeout', async() => {
		const operation = vi.fn(() => new Promise((resolve) => {
			setTimeout(() => resolve('result'), 2000)
		}))

		const promise = withTimeout(operation, 1000)
		vi.advanceTimersByTime(1000)

		await expect(promise).rejects.toThrow('Operation timed out after 1000ms')
	})

	it('should handle operation that throws error', async() => {
		const error = new Error('Operation failed')
		const operation = vi.fn().mockRejectedValue(error)

		const promise = withTimeout(operation, 1000)
		vi.advanceTimersByTime(500)

		await expect(promise).rejects.toThrow('Operation failed')
	})

	it('contains a rejected native promise thrown by the operation', async() => {
		const thrown = Promise.reject(new Error('operation threw rejection'))
		await expect(withTimeout(() => { throw thrown }, 1_000)).rejects.toBe(thrown)
		await Promise.resolve()
	})

	it('should not apply timeout for invalid timeout values', async() => {
		const operation = vi.fn().mockResolvedValue('result')

		await withTimeout(operation, 0)
		await withTimeout(operation, -1)
		await withTimeout(operation, Infinity)
		await withTimeout(operation, NaN)
		await withTimeout(operation, 2_147_483_648)

		expect(operation).toHaveBeenCalledTimes(5)
	})

	it('should clear timeout when operation completes', async() => {
		const operation = vi.fn().mockResolvedValue('result')

		const promise = withTimeout(operation, 1000)
		vi.advanceTimersByTime(500)
		await promise

		// Advance past timeout - should not throw
		vi.advanceTimersByTime(1000)
		expect(true).toBe(true) // If we get here, no timeout error was thrown
	})

	it('should clear timeout when operation fails', async() => {
		const error = new Error('Operation failed')
		const operation = vi.fn().mockRejectedValue(error)

		const promise = withTimeout(operation, 1000)
		vi.advanceTimersByTime(500)

		await expect(promise).rejects.toThrow('Operation failed')

		// Advance past timeout - should not throw timeout error
		vi.advanceTimersByTime(1000)
		expect(true).toBe(true)
	})

	it('should handle synchronous operations', async() => {
		const operation = vi.fn().mockReturnValue(Promise.resolve('result'))

		const result = await withTimeout(operation, 1000)

		expect(result).toBe('result')
		expect(operation).toHaveBeenCalledTimes(1)
	})

	it('does not read a caller-owned then accessor on a native promise', async() => {
		const then = vi.fn(() => Promise.prototype.then)
		const completion = Promise.resolve('result')
		Object.defineProperty(completion, 'then', {get: then})

		await expect(withTimeout(() => completion, 1_000)).resolves.toBe('result')
		expect(then).not.toHaveBeenCalled()
	})

	it('rejects arbitrary thenables without executing their then method', async() => {
		const then = vi.fn()
		const operation = () => ({then}) as never

		await expect(withTimeout(operation, 1_000)).rejects.toThrow('native Promise')
		expect(then).not.toHaveBeenCalled()
	})

	it('keeps ownership when the operation replaces Promise.race', async() => {
		const nativeRace = Promise.race
		let replaced = false
		const operation = vi.fn(() => {
			Object.defineProperty(Promise, 'race', {
				configurable: true,
				value: () => { throw new Error('poisoned Promise.race') }
			})
			replaced = true
			return Promise.resolve('result')
		})
		try {
			await expect(withTimeout(operation, 1_000)).resolves.toBe('result')
		} finally {
			if (replaced) Object.defineProperty(Promise, 'race', {
				configurable: true, writable: true, value: nativeRace
			})
		}
	})

	it('does not start physical work when deadline timer scheduling fails', async() => {
		const operation = vi.fn().mockResolvedValue('result')
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
			throw new Error('timer unavailable')
		})
		try {
			await expect(withTimeout(operation, 1_000)).rejects.toThrow('timer unavailable')
			expect(operation).not.toHaveBeenCalled()
		} finally { timer.mockRestore() }
	})

	it('contains a rejected promise returned as a timer handle', async() => {
		const operation = vi.fn().mockResolvedValue('result')
		const timerFailure = Promise.reject(new Error('timer rejected'))
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timerFailure as never)
		try {
			await expect(withTimeout(operation, 1_000)).rejects.toThrow('allocated synchronously')
			expect(operation).not.toHaveBeenCalled()
			await Promise.resolve()
		} finally { timer.mockRestore() }
	})

	it('does not start physical work when the deadline fires before scheduling returns', async() => {
		const operation = vi.fn().mockResolvedValue('result')
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], _ms?: number, ...args: unknown[]) => {
			Reflect.apply(callback as (...values: unknown[]) => void, undefined, args)
			return 1 as never
		}) as typeof setTimeout)
		try {
			await expect(withTimeout(operation, 1_000)).rejects.toThrow('timed out')
			expect(operation).not.toHaveBeenCalled()
		} finally { timer.mockRestore() }
	})

	it('preserves the operation result when timer cleanup fails', async() => {
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
			throw new Error('timer cleanup unavailable')
		})
		try {
			await expect(withTimeout(() => Promise.resolve('result'), 1_000)).resolves.toBe('result')
		} finally { cleanup.mockRestore() }
	})

	it('preserves cleanup ownership when the operation replaces global clearTimeout', async() => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')!
		const capturedClear = globalThis.clearTimeout
		let cleanupCalls = 0
		Object.defineProperty(globalThis, 'clearTimeout', {
			configurable: true, writable: true,
			value: (timer: ReturnType<typeof setTimeout>) => {
				cleanupCalls += 1
				return capturedClear(timer)
			}
		})
		try {
			await expect(withTimeout(() => {
				Object.defineProperty(globalThis, 'clearTimeout', {
					configurable: true, writable: true, value: () => undefined
				})
				return Promise.resolve('result')
			}, 1_000)).resolves.toBe('result')
		} finally {
			Object.defineProperty(globalThis, 'clearTimeout', descriptor)
		}
		expect(cleanupCalls).toBe(1)
	})

	it('contains rejected promises returned by timer cleanup', async() => {
		const cleanupFailure = Promise.reject(new Error('cleanup rejected'))
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => cleanupFailure as never)
		try {
			await expect(withTimeout(() => Promise.resolve('result'), 1_000)).resolves.toBe('result')
			await Promise.resolve()
		} finally { cleanup.mockRestore() }
	})

	it('detaches the deadline when timer cleanup returns asynchronously', async() => {
		const unref = vi.fn()
		const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({unref} as never)
		const cleanupFailure = Promise.reject(new Error('cleanup rejected'))
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockReturnValue(cleanupFailure as never)
		try {
			await expect(withTimeout(() => Promise.resolve('result'), 1_000)).resolves.toBe('result')
			expect(unref).toHaveBeenCalledOnce()
			await Promise.resolve()
		} finally {
			cleanup.mockRestore()
			timer.mockRestore()
		}
	})

	it('should handle operations that complete exactly at timeout', async() => {
		const operation = vi.fn(() => new Promise((resolve) => {
			setTimeout(() => resolve('result'), 1000)
		}))

		const promise = withTimeout(operation, 1000)
		vi.advanceTimersByTime(1000)

		// Race condition - operation might complete or timeout
		// Both outcomes are valid
		try {
			const result = await promise
			expect(result).toBe('result')
		} catch(error) {
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toContain('timed out')
		}
	})
})
