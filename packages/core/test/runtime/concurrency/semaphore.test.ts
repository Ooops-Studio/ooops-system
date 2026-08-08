import {describe, it, expect} from 'vitest'

import {createSemaphore, type Semaphore} from '../../../src/runtime/concurrency/semaphore'

describe('semaphore', () => {
	describe('createSemaphore', () => {
		it('should create semaphore with max permits', async() => {
			const sem = createSemaphore(3)
			const release1 = await sem.acquire()
			const release2 = await sem.acquire()
			const release3 = await sem.acquire()

			expect(typeof release1).toBe('function')
			expect(typeof release2).toBe('function')
			expect(typeof release3).toBe('function')
		})

		it('should block when all permits are acquired', async() => {
			const sem = createSemaphore(2)
			const release1 = await sem.acquire()
			const _release2 = await sem.acquire()

			let acquired = false
			const acquirePromise = sem.acquire().then(() => {
				acquired = true
			})

			// Should not be acquired yet
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(acquired).toBe(false)

			// Release one permit
			release1()
			await acquirePromise
			expect(acquired).toBe(true)
		})

		it('should release permit when release is called', async() => {
			const sem = createSemaphore(1)
			const release1 = await sem.acquire()

			let acquired = false
			const acquirePromise = sem.acquire().then(() => {
				acquired = true
			})

			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(acquired).toBe(false)

			release1()
			await acquirePromise
			expect(acquired).toBe(true)
		})

		it('should handle multiple releases', async() => {
			const sem = createSemaphore(1)
			const release1 = await sem.acquire()
			release1()
			release1() // Should be idempotent

			const release2 = await sem.acquire()
			expect(typeof release2).toBe('function')
		})

		it('does not leak a permit when Promise.resolve is replaced', async() => {
			const nativeResolve = Promise.resolve
			const sem = createSemaphore(1)
			let pending!: Promise<() => void>
			Object.defineProperty(Promise, 'resolve', {
				configurable: true,
				value: () => { throw new Error('poisoned Promise.resolve') }
			})
			try { pending = sem.acquire() } finally {
				Object.defineProperty(Promise, 'resolve', {
					configurable: true, writable: true, value: nativeResolve
				})
			}
			const release = await pending
			release()
			await expect(sem.acquire()).resolves.toBeTypeOf('function')
		})

		it('should queue multiple waiters', async() => {
			const sem = createSemaphore(1)
			const release1 = await sem.acquire()

			const acquire2 = sem.acquire()
			const acquire3 = sem.acquire()

			// Both should be waiting
			await new Promise((resolve) => setTimeout(resolve, 10))

			release1()

			const release2 = await acquire2
			release2()

			const release3 = await acquire3
			expect(typeof release3).toBe('function')
		})

		it('should handle zero max', () => {
			const sem = createSemaphore(0)
			// Should default to 1
			expect(sem).toBeDefined()
		})

		it('should handle negative max', () => {
			const sem = createSemaphore(-5)
			// Should default to 1
			expect(sem).toBeDefined()
		})

		it('should handle fractional max', () => {
			const sem = createSemaphore(2.7)
			// Should floor to 2
			expect(sem).toBeDefined()
		})

		it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
			'rejects non-finite max %s instead of deadlocking or disabling the limit',
			(max) => {
				expect(() => createSemaphore(max)).toThrow(RangeError)
			}
		)

		it('contains a rejected promise supplied as the permit count', async() => {
			const rejected = Promise.reject(new Error('max rejected'))
			expect(() => createSemaphore(rejected as never)).toThrow(RangeError)
			await Promise.resolve()
		})

		it('rejects unsafe permit counts and bounds queued waiters', async() => {
			expect(() => createSemaphore(1_000_001)).toThrow('no greater than')
			const semaphore = createSemaphore(1)
			const firstRelease = await semaphore.acquire()
			const queued = Array.from({length: 4_096}, () => semaphore.acquire())

			await expect(semaphore.acquire()).rejects.toThrow('waiter limit')
			firstRelease()
			for (const pending of queued) {
				const release = await pending
				release()
			}
		})

		it('keeps a continuously saturated waiter queue operational across compaction', async() => {
			const semaphore = createSemaphore(1)
			let release = await semaphore.acquire()
			const pending = Array.from({length: 4_096}, () => semaphore.acquire())
			const rotations = 5_000

			for (let index = 0; index < rotations; index += 1) {
				release()
				release = await pending[index]!
				pending.push(semaphore.acquire())
			}
			await expect(semaphore.acquire()).rejects.toThrow('waiter limit')

			for (let index = rotations; index < pending.length; index += 1) {
				release()
				release = await pending[index]!
			}
			release()
		}, 120_000)

		it('does not lose a permit when Array.prototype.splice is rewired at compaction', async() => {
			const semaphore = createSemaphore(1)
			let release = await semaphore.acquire()
			const pending = Array.from({length: 4_096}, () => semaphore.acquire())
			for (let index = 0; index < 4_095; index += 1) {
				release()
				release = await pending[index]!
				pending.push(semaphore.acquire())
			}

			const nativeSplice = Array.prototype.splice
			Object.defineProperty(Array.prototype, 'splice', {
				configurable: true,
				value: () => { throw new Error('poisoned Array.prototype.splice') }
			})
			try { expect(() => release()).not.toThrow() } finally {
				Object.defineProperty(Array.prototype, 'splice', {
					configurable: true, writable: true, value: nativeSplice
				})
			}
			release = await pending[4_095]!
			for (let index = 4_096; index < pending.length; index += 1) {
				release()
				release = await pending[index]!
			}
			release()
		})

		it('should implement Semaphore interface', () => {
			const sem: Semaphore = createSemaphore(1)
			expect(typeof sem.acquire).toBe('function')
		})

		it('should handle concurrent acquires and releases', async() => {
			const sem = createSemaphore(2)
			const releases: Array<() => void> = []

			// Acquire all permits
			for (let i = 0; i < 2; i++) {
				releases.push(await sem.acquire())
			}

			// Queue more acquires
			const acquirePromises = []
			for (let i = 0; i < 2; i++) {
				acquirePromises.push(sem.acquire())
			}

			// Release all
			releases.forEach((release) => release())

			// All queued acquires should complete
			const newReleases = await Promise.all(acquirePromises)
			expect(newReleases.length).toBe(2)
			newReleases.forEach((release) => {
				expect(typeof release).toBe('function')
				release() // Clean up
			})
		}, 10000) // Increase timeout
	})
})
