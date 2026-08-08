import {afterEach, describe, expect, it, vi} from 'vitest'

import {createCircuitProtectedSink} from '../../../src/features/transferring/circuit-protected-sink'
import {FAILED_DELIVERY_LINES, type LoggingDeliveryError} from '../../../src/features/transferring/delivery'

describe('createCircuitProtectedSink', () => {
	afterEach(() => vi.useRealTimers())

	it('reports the exact undelivered suffix when a sequential batch fails', async() => {
		const sink = {
			write: vi.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('second line failed'))
		}
		const protectedSink = createCircuitProtectedSink(sink, {
			failureThreshold: 10,
			halfOpenAfterMs: 1_000,
			maxHalfOpenProbes: 1
		})

		const rejection = await Promise.resolve(protectedSink.writeBatch?.(['line1', 'line2', 'line3']))
			.then(() => undefined, (error: unknown) => error as LoggingDeliveryError)

		expect(rejection?.[FAILED_DELIVERY_LINES]).toEqual(['line2', 'line3'])
		expect(rejection?.deliveredCount).toBe(1)
		expect(sink.write).toHaveBeenCalledTimes(2)
	})

	it('ignores stale half-open success after another probe reopens the circuit', async() => {
		vi.useFakeTimers()
		let resolveSuccess!: () => void
		let rejectFailure!: (error: unknown) => void
		const sink = {
			write: vi.fn((line: string) => {
				if (line === 'open') return Promise.reject(new Error('open circuit'))
				if (line === 'success') return new Promise<void>((resolve) => { resolveSuccess = resolve })
				return new Promise<void>((_, reject) => { rejectFailure = reject })
			})
		}
		const protectedSink = createCircuitProtectedSink(sink, {
			failureThreshold: 1,
			halfOpenAfterMs: 20,
			maxHalfOpenProbes: 2
		})

		await expect(protectedSink.write('open')).rejects.toThrow('open circuit')
		await vi.advanceTimersByTimeAsync(25)
		const success = protectedSink.write('success')
		const failure = protectedSink.write('failure')
		rejectFailure(new Error('probe failed'))
		await expect(failure).rejects.toThrow('probe failed')
		resolveSuccess()
		await success

		await expect(protectedSink.write('blocked')).rejects.toMatchObject({
			code: 'LOGGING_REMOTE_BREAKER_OPEN'
		})
		expect(sink.write).toHaveBeenCalledTimes(3)
	})

	it('does not let a fast half-open success hide a concurrent probe failure', async() => {
		vi.useFakeTimers()
		let resolveSuccess!: () => void
		let rejectFailure!: (error: unknown) => void
		const sink = {
			write: vi.fn((line: string) => {
				if (line === 'open') return Promise.reject(new Error('open circuit'))
				if (line === 'success') return new Promise<void>((resolve) => { resolveSuccess = resolve })
				return new Promise<void>((_, reject) => { rejectFailure = reject })
			})
		}
		const protectedSink = createCircuitProtectedSink(sink, {
			failureThreshold: 1,
			halfOpenAfterMs: 20,
			maxHalfOpenProbes: 2
		})

		await expect(protectedSink.write('open')).rejects.toThrow('open circuit')
		await vi.advanceTimersByTimeAsync(25)
		const success = protectedSink.write('success')
		const failure = protectedSink.write('failure')
		resolveSuccess()
		await success
		rejectFailure(new Error('late probe failed'))
		await expect(failure).rejects.toThrow('late probe failed')

		await expect(protectedSink.write('blocked')).rejects.toMatchObject({
			code: 'LOGGING_REMOTE_BREAKER_OPEN'
		})
	})
})
