/**
 * @file Tests for bulkhead queue timeout/cancellation and inspect/reset behavior.
 */

import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createBulkheadEngine} from '../../../src/resilience/core/bulkhead'

describe('bulkhead', () => {
	const bucket = 'db.critical'
	const scope = 'resource' as const
	const id = 'tenant-1'

	it('times out queued work when queueTimeoutMs elapses', async() => {
		const clock = createFixedClock(1000)
		const bulkhead = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 1,
				overflowStrategy: 'reject',
				queueTimeoutMs: 10
			}
		})

		await bulkhead.acquire(bucket, scope, id)

		await expect(
			bulkhead.acquire(bucket, scope, id)
		).rejects.toMatchObject({name: 'BulkheadQueueError', reason: 'queue-timeout'})
	})

	it('cancels queued work when AbortSignal aborts', async() => {
		const clock = createFixedClock(1000)
		const bulkhead = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 1,
				overflowStrategy: 'reject',
				queueTimeoutMs: 100
			}
		})

		await bulkhead.acquire(bucket, scope, id)

		const controller = new AbortController()
		const pending = bulkhead.acquire(bucket, scope, id, {signal: controller.signal})
		controller.abort()

		await expect(pending).rejects.toThrow('Bulkhead acquire cancelled')
	})

	it('rolls back queued work when cancellation listener installation fails', async() => {
		const bulkhead = createBulkheadEngine({
			clock: createFixedClock(0),
			config: {maxConcurrent: 1, maxQueueSize: 1, overflowStrategy: 'reject'}
		})
		const owner = await bulkhead.acquire(bucket, scope, id)
		let prototypeReads = 0
		let hostile: object
		hostile = new Proxy({}, {getPrototypeOf: () => { prototypeReads++; return hostile }})
		const signal = {
			aborted: false,
			addEventListener: () => { throw hostile },
			removeEventListener: () => { throw new Error('listener cleanup failed') }
		} as unknown as AbortSignal
		await expect(bulkhead.acquire(bucket, scope, id, {signal})).rejects.toThrow('Bulkhead cancellation listener failed')
		expect(prototypeReads).toBe(0)
		bulkhead.release(bucket, scope, id, owner.permit!)
		await expect(bulkhead.acquire(bucket, scope, id)).resolves.toMatchObject({allowed: true})
	})

	it('snapshots acquire options before publishing a queue claim', async() => {
		const bulkhead = createBulkheadEngine({
			clock: createFixedClock(0),
			config: {maxConcurrent: 1, maxQueueSize: 1, overflowStrategy: 'reject'}
		})
		const owner = await bulkhead.acquire(bucket, scope, id)
		let reads = 0
		const options = Object.defineProperty({}, 'signal', {
			enumerable: true,
			get: () => {
				if (++reads < 3) return undefined
				throw new Error('shape shifted after claim')
			}
		})

		await expect(bulkhead.acquire(bucket, scope, id, options as never))
			.rejects.toThrow(/plain data object/u)
		expect(reads).toBe(0)
		bulkhead.release(bucket, scope, id, owner.permit!)
		const next = await bulkhead.acquire(bucket, scope, id)
		expect(next).toMatchObject({allowed: true})
		bulkhead.release(bucket, scope, id, next.permit!)
	})

	it('does not strand a settled waiter when the queue timer fires synchronously', async() => {
		const bulkhead = createBulkheadEngine({
			clock: createFixedClock(0),
			config: {maxConcurrent: 1, maxQueueSize: 1, overflowStrategy: 'reject', queueTimeoutMs: 10}
		})
		const owner = await bulkhead.acquire(bucket, scope, id)
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0]) => {
			Reflect.apply(callback as (...arguments_: unknown[]) => unknown, undefined, [])
			return 0 as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout)

		await expect(bulkhead.acquire(bucket, scope, id)).rejects.toMatchObject({reason: 'queue-timeout'})
		timer.mockRestore()
		bulkhead.release(bucket, scope, id, owner.permit!)
		await expect(bulkhead.acquire(bucket, scope, id)).resolves.toMatchObject({allowed: true})
	})

	it('uses one-shot permits so duplicate releases cannot free another operation', async() => {

		const clock = createFixedClock(1000)
		const bulkhead = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 0,
				overflowStrategy: 'reject'
			}
		})

		const first = await bulkhead.acquire(bucket, scope, id)
		bulkhead.release(bucket, scope, id, first.permit!)
		const second = await bulkhead.acquire(bucket, scope, id)
		bulkhead.release(bucket, scope, id, first.permit!)
		await expect(bulkhead.acquire(bucket, scope, id)).resolves.toMatchObject({allowed: false})
		bulkhead.release(bucket, scope, id, second.permit!)
	})

	it('snapshots capacity so later config mutation cannot widen admission', async() => {
		const mutableConfig = {maxConcurrent: 1, maxQueueSize: 0, overflowStrategy: 'reject' as const}
		const bulkhead = createBulkheadEngine({clock: createFixedClock(0), config: mutableConfig})
		;(mutableConfig as {maxConcurrent: number}).maxConcurrent = 10_000

		const admitted = await bulkhead.acquire(bucket, scope, id)
		await expect(bulkhead.acquire(bucket, scope, id)).resolves.toMatchObject({allowed: false})
		bulkhead.release(bucket, scope, id, admitted.permit!)
	})

	it('rejects every queued operation during destroy', async() => {

		const clock = createFixedClock(1_000)
		const bulkhead = createBulkheadEngine({
			clock,
			config: {maxConcurrent: 1, maxQueueSize: 2, overflowStrategy: 'reject'}
		})

		await bulkhead.acquire(bucket, scope, id)
		const firstDestroyed = bulkhead.acquire(bucket, scope, id)
		const secondDestroyed = bulkhead.acquire(bucket, scope, id)
		bulkhead.destroy()
		await expect(Promise.allSettled([firstDestroyed, secondDestroyed])).resolves.toEqual([
			expect.objectContaining({status: 'rejected'}),
			expect.objectContaining({status: 'rejected'})
		])

	})

	it('validates config and handles reject, degrade, drop-oldest, release, and destroy branches', async() => {
		const clock = createFixedClock(1000)
		const coerce = vi.fn(() => 1)
		expect(() => createBulkheadEngine({
			clock,
			config: {maxConcurrent: {[Symbol.toPrimitive]: coerce}, maxQueueSize: 0, overflowStrategy: 'reject'} as never
		})).toThrow(/maxConcurrent/u)
		expect(coerce).not.toHaveBeenCalled()

		expect(() => createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 0,
				maxQueueSize: 1,
				overflowStrategy: 'reject'
			}
		})).toThrow(/maxConcurrent/i)

		expect(() => createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: -1,
				overflowStrategy: 'reject'
			}
		})).toThrow(/maxQueueSize/i)

		expect(() => createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 1,
				overflowStrategy: 'reject',
				queueTimeoutMs: 0
			}
		})).toThrow(/queueTimeoutMs/i)
		expect(() => createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 1,
				overflowStrategy: 'reject',
				queueTimeoutMs: 2_147_483_648
			}
		})).toThrow(/2147483647/i)

		expect(() => createBulkheadEngine({
			clock,
			config: {maxConcurrent: 1, maxQueueSize: 1, overflowStrategy: 'invalid' as never}
		})).toThrow(/overflowStrategy/i)

		const rejecting = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 0,
				overflowStrategy: 'reject'
			}
		})

		const rejectedOwner = await rejecting.acquire(bucket, scope, id)
		await expect(rejecting.acquire(bucket, scope, id)).resolves.toEqual({
			allowed: false,
			bucket,
			reason: 'Queue full, rejecting'
		})
		rejecting.release(bucket, scope, id, rejectedOwner.permit!)

		const degrading = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 0,
				overflowStrategy: 'degrade'
			}
		})
		await degrading.acquire(bucket, scope, id)
		await expect(degrading.acquire(bucket, scope, id)).resolves.toEqual({
			allowed: false,
			bucket,
			reason: 'Queue full, degrading',
			action: 'degrade'
		})

		const dropping = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 1,
				overflowStrategy: 'drop-oldest'
			}
		})
		const droppingOwner = await dropping.acquire(bucket, scope, id)
		const dropped = dropping.acquire(bucket, scope, id)
		const promoted = dropping.acquire(bucket, scope, id)
		await expect(dropped).rejects.toMatchObject({name: 'BulkheadQueueError', reason: 'drop-oldest'})
		dropping.release(bucket, scope, id, droppingOwner.permit!)
		const promotedResult = await promoted
		expect(promotedResult).toMatchObject({allowed: true, bucket})
		dropping.release(bucket, scope, id, promotedResult.permit!)
		expect(() => dropping.release('missing', scope, id, Symbol('missing'))).not.toThrow()

		const zeroQueueDropOldest = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 0,
				overflowStrategy: 'drop-oldest'
			}
		})
		await zeroQueueDropOldest.acquire(bucket, scope, id)
		await expect(zeroQueueDropOldest.acquire(bucket, scope, id)).resolves.toEqual({
			allowed: false,
			bucket,
			reason: 'Queue full, dropping newest'
		})
		await dropping.acquire(bucket, scope, id)
		const destroyed = dropping.acquire(bucket, scope, id)
		dropping.destroy()
		await expect(destroyed).rejects.toThrow('Bulkhead destroyed')
		await expect(dropping.acquire(bucket, scope, id)).rejects.toThrow('Bulkhead destroyed')
	})

	it('handles already-aborted signals without creating queued work', async() => {
		const clock = createFixedClock(2000)
		const bulkhead = createBulkheadEngine({
			clock,
			config: {
				maxConcurrent: 1,
				maxQueueSize: 1,
				overflowStrategy: 'reject'
			}
		})

		await bulkhead.acquire(bucket, scope, id)

		const controller = new AbortController()
		controller.abort()

		await expect(bulkhead.acquire(bucket, scope, id, {signal: controller.signal})).rejects.toThrow('Bulkhead acquire cancelled')

		const immediate = createBulkheadEngine({
			clock,
			config: {maxConcurrent: 1, maxQueueSize: 1, overflowStrategy: 'reject'}
		})
		await expect(immediate.acquire('immediate', scope, id, {signal: controller.signal})).rejects.toThrow('Bulkhead acquire cancelled')
	})

	it('bounds distinct active isolation buckets without evicting active permits', async() => {
		const bounded = createBulkheadEngine({
			clock: createFixedClock(0), maxBuckets: 2,
			config: {maxConcurrent: 1, maxQueueSize: 0, overflowStrategy: 'reject'}
		})
		const first = await bounded.acquire(bucket, 'tenant', 'one')
		await expect(bounded.acquire(bucket, 'tenant', 'two')).resolves.toMatchObject({allowed: true})
		await expect(bounded.acquire(bucket, 'tenant', 'three')).resolves.toEqual({
			allowed: false, bucket, reason: 'Bulkhead bucket capacity reached'
		})

		bounded.release(bucket, 'tenant', 'one', first.permit!)
		await expect(bounded.acquire(bucket, 'tenant', 'three')).resolves.toMatchObject({allowed: true})
		expect(() => createBulkheadEngine({
			clock: createFixedClock(0), maxBuckets: 0,
			config: {maxConcurrent: 1, maxQueueSize: 0, overflowStrategy: 'reject'}
		})).toThrow(/maxBuckets/i)
	})

	it('bounds total permits across the engine and returns global capacity on release', async() => {
		const bounded = createBulkheadEngine({
			clock: createFixedClock(0),
			config: {maxConcurrent: 10_000, maxQueueSize: 0, overflowStrategy: 'reject'}
		})
		const permits = await Promise.all(Array.from(
			{length: 10_000},
			() => bounded.acquire('bounded', 'resource', 'same')
		))
		expect(permits.every((permit) => permit.allowed)).toBe(true)
		await expect(bounded.acquire('other', 'resource', 'other')).resolves.toMatchObject({
			allowed: false,
			reason: 'Bulkhead global capacity reached'
		})

		bounded.release('bounded', 'resource', 'same', permits[0]!.permit!)
		await expect(bounded.acquire('other', 'resource', 'other'))
			.resolves.toMatchObject({allowed: true})
	})
})
