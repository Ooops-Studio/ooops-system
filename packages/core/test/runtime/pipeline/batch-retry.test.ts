import {describe, expect, it, vi} from 'vitest'

import {createNativePromise} from '../../../src/runtime/async/native-promise'
import {createBatchRetryPipeline} from '../../../src/runtime/pipeline/batch-retry'
import {createBatchRetryTracking} from '../../../src/runtime/pipeline/batch-retry-tracking'

const options = <T>(send: (items: readonly T[]) => Promise<void>) => ({
	batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 1_000},
	retry: {
		maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
		jitter: 0, attemptTimeoutMs: 1_000
	},
	clock: {now: () => 0},
	send
})

describe('createBatchRetryPipeline', () => {
	it('contains rejected promises supplied as pipeline configuration', async() => {
		const rejectedOptions = Promise.reject(new Error('options rejected'))
		expect(() => createBatchRetryPipeline(rejectedOptions as never)).toThrow('options')
		const rejectedTelemetry = Promise.reject(new Error('telemetry rejected'))
		expect(() => createBatchRetryPipeline({
			...options(async() => undefined), telemetry: rejectedTelemetry as never
		})).toThrow('telemetry')
		await Promise.resolve()
	})

	it('rejects unsafe policies before allocating runtime work', () => {
		const send = vi.fn(async() => {})
		expect(() => createBatchRetryPipeline({
			...options(send), batching: {maxBatch: Number.MAX_SAFE_INTEGER, maxBytes: 1, maxIntervalMs: 1}
		})).toThrow('Invalid batch retry batching policy')
		expect(() => createBatchRetryPipeline({
			...options(send), retry: {...options(send).retry, maxAttempts: Number.MAX_SAFE_INTEGER}
		})).toThrow('Invalid batch retry policy')
	})

	it('snapshots validated policies so later mutation cannot remove runtime bounds', async() => {
		const send = vi.fn(async() => { throw new Error('offline') })
		const batching = {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 1_000}
		const retry = {
			maxAttempts: 1, baseDelayMs: 0, multiplier: 1, maxDelayMs: 0,
			jitter: 0, attemptTimeoutMs: 1_000
		}
		const pipeline = createBatchRetryPipeline({...options(send), batching, retry})
		batching.maxBatch = 10_000
		batching.maxBytes = 100_000_000
		retry.maxAttempts = 100

		pipeline.write('one')
		await pipeline.flush()
		expect(send).toHaveBeenCalledOnce()
		await pipeline.close()
	})

	it('never admits or sends a single item larger than the hard batch byte limit', async() => {
		const send = vi.fn(async() => undefined)
		const onDropped = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 10, maxBytes: 10, maxIntervalMs: 1_000},
			getItemSize: () => 11,
			telemetry: {onDropped}
		})

		pipeline.write('oversized')
		await pipeline.flush()

		expect(send).not.toHaveBeenCalled()
		expect(pipeline.getBatchSize()).toBe(0)
		expect(pipeline.getBatchBytes()).toBe(0)
		expect(onDropped).toHaveBeenCalledWith(1, 'item-too-large')
		await pipeline.close()
	})

	it('preserves admitted batches when Array push and splice are rewired during sizing', async() => {
		const nativePush = Array.prototype.push
		const nativeSplice = Array.prototype.splice
		const restore = (): void => {
			Object.defineProperties(Array.prototype, {
				push: {configurable: true, writable: true, value: nativePush},
				splice: {configurable: true, writable: true, value: nativeSplice}
			})
		}
		let sends = 0
		const pipeline = createBatchRetryPipeline({
			...options(async() => { sends += 1 }),
			getItemSize: () => {
				Object.defineProperties(Array.prototype, {
					push: {configurable: true, value: () => { throw new Error('poisoned Array.push') }},
					splice: {configurable: true, value: () => { throw new Error('poisoned Array.splice') }}
				})
				queueMicrotask(restore)
				return 1
			}
		})

		try {
			pipeline.write('one')
			await pipeline.flush()
			expect(sends).toBe(1)
		} finally { restore() }
		await pipeline.close()
	})

	it('rejects accessor-backed policies without executing their getters', () => {
		let reads = 0
		const batching = Object.defineProperty({maxBytes: 1_000, maxIntervalMs: 1_000}, 'maxBatch', {
			enumerable: true,
			get: () => { reads++; return 1 }
		})
		expect(() => createBatchRetryPipeline({...options(async() => {}), batching: batching as never}))
			.toThrow('data properties')
		expect(reads).toBe(0)
	})

	it('contains synchronous send lifecycle re-entry after publishing ownership', async() => {
		let pipeline!: ReturnType<typeof createBatchRetryPipeline<string>>
		const send = vi.fn(async() => {
			const nestedFlush = pipeline.flush()
			const nestedClose = pipeline.close()
			await Promise.all([nestedFlush, nestedClose])
		})
		pipeline = createBatchRetryPipeline(options(send))

		pipeline.write('one')
		await expect(pipeline.flush()).resolves.toBeUndefined()
		expect(send).toHaveBeenCalledOnce()
		await expect(pipeline.close()).resolves.toBeUndefined()
	})

	it('contains asynchronous send lifecycle re-entry without deadlocking its own barrier', async() => {
		let pipeline!: ReturnType<typeof createBatchRetryPipeline<string>>
		let sends = 0
		const send = async() => {
			sends += 1
			await Promise.resolve()
			pipeline.write('nested')
			await pipeline.flush()
			await pipeline.close()
		}
		pipeline = createBatchRetryPipeline(options(send))
		pipeline.write('one')
		let watchdog: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_resolve, reject) => {
			watchdog = setTimeout(() => { reject(new Error('async integration re-entry deadlocked')) }, 250)
		})

		try {
			await expect(Promise.race([pipeline.flush(), deadline])).resolves.toBeUndefined()
		} finally {
			if (watchdog) clearTimeout(watchdog)
		}
		expect(sends).toBe(1)
		expect(pipeline.getBatchSize()).toBe(0)
		await pipeline.close()
	})

	it('does not assimilate arbitrary thenables returned by the send integration', async() => {
		const then = vi.fn()
		const onError = vi.fn()
		const send = vi.fn(() => ({then}) as never)
		const pipeline = createBatchRetryPipeline({...options(send), telemetry: {onError}})

		pipeline.write('one')
		await pipeline.flush()

		expect(then).not.toHaveBeenCalled()
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			message: 'Batch retry send must return an adoptable native Promise'
		}))
		await pipeline.close()
	})

	it('contains rejected promises returned by synchronous integration hooks', async() => {
		const onError = vi.fn()
		const getItemSizePipeline = createBatchRetryPipeline({
			...options(async() => undefined),
			getItemSize: () => Promise.reject(new Error('size failed')) as never,
			telemetry: {onError}
		})
		getItemSizePipeline.write('size')
		expect(getItemSizePipeline.getBatchSize()).toBe(0)

		const preparePipeline = createBatchRetryPipeline({
			...options(async() => undefined),
			prepareItems: () => Promise.reject(new Error('prepare failed')) as never,
			telemetry: {onError}
		})
		preparePipeline.write('prepare')
		await preparePipeline.flush()

		const retryPipeline = createBatchRetryPipeline({
			...options(async() => { throw new Error('send failed') }),
			getRetryItems: () => Promise.reject(new Error('projection failed')) as never,
			telemetry: {onError}
		})
		retryPipeline.write('retry')
		await retryPipeline.flush()

		await Promise.resolve()
		expect(onError).toHaveBeenCalled()
		await Promise.all([
			getItemSizePipeline.close(), preparePipeline.close(), retryPipeline.close()
		])
	})

	it('preserves an admitted batch when Promise.resolve is replaced during admission', async() => {
		const nativeResolve = Promise.resolve
		const send = vi.fn(async() => undefined)
		let replaced = false
		const pipeline = createBatchRetryPipeline({
			...options(send),
			getItemSize: () => {
				Object.defineProperty(Promise, 'resolve', {
					configurable: true,
					value: () => { throw new Error('poisoned Promise.resolve') }
				})
				replaced = true
				return 1
			}
		})

		try {
			pipeline.write('one')
		} finally {
			if (replaced) Object.defineProperty(Promise, 'resolve', {
				configurable: true, writable: true, value: nativeResolve
			})
		}

		await expect(pipeline.flush()).resolves.toBeUndefined()
		expect(send).toHaveBeenCalledOnce()
		await pipeline.close()
	})

	it('preserves delivery ownership when Promise.race is replaced by the sender', async() => {
		const nativeRace = Promise.race
		let replaced = false
		const send = vi.fn(async() => {
			Object.defineProperty(Promise, 'race', {
				configurable: true,
				value: () => { throw new Error('poisoned Promise.race') }
			})
			replaced = true
		})
		const pipeline = createBatchRetryPipeline(options(send))

		try {
			pipeline.write('one')
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(send).toHaveBeenCalledOnce()
		} finally {
			if (replaced) Object.defineProperty(Promise, 'race', {
				configurable: true, writable: true, value: nativeRace
			})
		}
		await pipeline.close()
	})

	it('preserves delivery ownership when the sender replaces Reflect.apply', async() => {
		const applyDescriptor = Object.getOwnPropertyDescriptor(Reflect, 'apply')!
		let attempts = 0
		const observed: string[][] = []
		const send = async(items: readonly string[]) => {
			attempts += 1
			observed.push([...items])
			if (attempts === 1) {
				Object.defineProperty(Reflect, 'apply', {
					configurable: true,
					writable: true,
					value: () => { throw new Error('poisoned Reflect.apply') }
				})
				throw new Error('retryable failure')
			}
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 0}
		})

		try {
			pipeline.write('one')
			pipeline.write('two')
			await pipeline.flush()
		} finally {
			Object.defineProperty(Reflect, 'apply', applyDescriptor)
		}

		expect(observed).toEqual([['one', 'two'], ['one', 'two']])
		await pipeline.close()
	})

	it('preserves retry deadlines when the sender replaces global timer capabilities', async() => {
		const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')!
		const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')!
		let replaced = false
		let attempts = 0
		const send = async() => {
			attempts += 1
			if (attempts !== 1) return
			Object.defineProperties(globalThis, {
				setTimeout: {
					configurable: true,
					writable: true,
					value: () => { throw new Error('poisoned setTimeout') }
				},
				clearTimeout: {
					configurable: true,
					writable: true,
					value: () => { throw new Error('poisoned clearTimeout') }
				}
			})
			replaced = true
			throw new Error('retryable failure')
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 1}
		})

		try {
			pipeline.write('one')
			await pipeline.flush()
		} finally {
			if (replaced) Object.defineProperties(globalThis, {
				setTimeout: setTimeoutDescriptor,
				clearTimeout: clearTimeoutDescriptor
			})
		}

		expect(attempts).toBe(2)
		await pipeline.close()
	})

	it('preserves retry ownership when the sender replaces Array iteration', async() => {
		const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
		let replaced = false
		let attempts = 0
		const send = async() => {
			attempts += 1
			if (attempts !== 1) return
			Object.defineProperty(Array.prototype, Symbol.iterator, {
				configurable: true,
				writable: true,
				value: () => { throw new Error('poisoned Array iterator') }
			})
			replaced = true
			throw new Error('retryable failure')
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 0},
			getRetryItems: (_error, items) => items
		})

		try {
			pipeline.write('one')
			await pipeline.flush()
		} finally {
			if (replaced) Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor)
		}

		expect(attempts).toBe(2)
		await pipeline.close()
	})

	it('adopts sender completion without reading a replaced Promise.prototype.then', async() => {
		const nativeThen = Promise.prototype.then
		const source = Promise.resolve()
		let sends = 0
		let replaced = false
		const send = () => {
			sends += 1
			Object.defineProperty(Promise.prototype, 'then', {
				configurable: true,
				value: () => { throw new Error('poisoned Promise.prototype.then') }
			})
			replaced = true
			return source
		}
		const pipeline = createBatchRetryPipeline(options(send))

		try {
			pipeline.write('one')
			const barrier = pipeline.flush()
			await barrier
		} finally {
			if (replaced) Object.defineProperty(Promise.prototype, 'then', {
				configurable: true, writable: true, value: nativeThen
			})
		}
		expect(sends).toBe(1)
		await pipeline.close()
	})

	it('does not duplicate delivery when the sender returns an unadoptable native promise', async() => {
		const onError = vi.fn()
		let sends = 0
		const send = () => {
			sends += 1
			const completion = Promise.resolve()
			Object.defineProperty(completion, 'constructor', {value: null})
			return completion
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 3},
			telemetry: {onError}
		})

		pipeline.write('one')
		await pipeline.flush()
		expect(sends).toBe(1)
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			ambiguousDelivery: true, nonRetryable: true
		}))
		await pipeline.close()
	})

	it('does not expose retry ownership to sender array mutation', async() => {
		let attempt = 0
		const observed: string[][] = []
		const send = vi.fn(async(items: readonly string[]) => {
			attempt += 1
			observed.push([...items])
			if (attempt === 1) {
				;(items as string[]).length = 0
				throw new Error('retryable failure')
			}
		})
		const onSuccess = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 0},
			telemetry: {onSuccess}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(observed).toEqual([['one', 'two'], ['one', 'two']])
		expect(onSuccess).toHaveBeenCalledWith(2)
		await pipeline.close()
	})

	it('does not expose retry ownership to prepareItems array mutation', async() => {
		const send = vi.fn(async() => undefined)
		const onDropped = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			prepareItems: (items) => {
				;(items as string[]).length = 0
				return {items}
			},
			telemetry: {onDropped}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(send).not.toHaveBeenCalled()
		expect(onDropped).toHaveBeenCalledWith(2, 'invalid-prepare-items')
		await pipeline.close()
	})

	it('does not expose retry ownership to getRetryItems array mutation', async() => {
		const send = vi.fn()
			.mockRejectedValueOnce(new Error('retryable failure'))
			.mockResolvedValueOnce(undefined)
		const onDropped = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2},
			getRetryItems: (_error, items) => {
				;(items as string[]).length = 0
				return items
			},
			telemetry: {onDropped}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(send.mock.calls.map(([items]) => items)).toEqual([['one', 'two']])
		expect(onDropped).not.toHaveBeenCalled()
		await pipeline.close()
	})

	it('preserves ambiguous ownership when getRetryItems throws', async() => {
		const projectionError = new Error('projection unavailable')
		const send = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('second item failed'), {deliveredCount: 1}))
			.mockResolvedValueOnce(undefined)
		const onError = vi.fn()
		const onDropped = vi.fn()
		const configured = options(send)
		const pipeline = createBatchRetryPipeline({
			...configured,
			batching: {...configured.batching, maxBatch: 2},
			retry: {...configured.retry, maxAttempts: 2},
			getRetryItems: () => { throw projectionError },
			telemetry: {onError, onDropped}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(send.mock.calls.map(([items]) => items)).toEqual([['one', 'two']])
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			code: 'DELIVERY_RETRY_PROJECTION_INVALID',
			ambiguousDelivery: true,
			nonRetryable: true,
			cause: projectionError
		}))
		expect(onDropped).not.toHaveBeenCalled()
		await pipeline.close()
	})

	it('bounds rollover admission to one pending batch while a send is physical', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const send = vi.fn(async() => { await gate })
		const onDropped = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send), telemetry: {onDropped}
		})

		pipeline.write('first')
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
		pipeline.write('second')
		for (let index = 0; index < 100; index += 1) pipeline.write(`overflow-${index}`)

		expect(pipeline.getBatchSize()).toBe(1)
		expect(onDropped).toHaveBeenCalledTimes(100)
		release()
		await pipeline.flush()
		expect(send).toHaveBeenCalledTimes(2)
		await pipeline.close()
	})

	it('does not let traffic admitted during a send starve an existing flush barrier', async() => {
		const releases: Array<() => void> = []
		const send = vi.fn(async() => await new Promise<void>((resolve) => { releases.push(resolve) }))
		const pipeline = createBatchRetryPipeline(options(send))

		pipeline.write('first')
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
		pipeline.write('second')
		const barrier = pipeline.flush()

		releases[0]!()
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
		pipeline.write('third')
		releases[1]!()

		await expect(barrier).resolves.toBeUndefined()
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3))
		releases[2]!()
		await pipeline.close()
	})

	it('refs an in-flight attempt timeout while an explicit flush owns its barrier', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const attemptTimers: Array<ReturnType<typeof setTimeout>> = []
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			const timer = nativeSetTimeout(callback, ms, ...args)
			if (ms === 10_000) attemptTimers.push(timer)
			return timer
		}) as typeof setTimeout)
		let release!: () => void
		const send = vi.fn(async() => await new Promise<void>((resolve) => { release = resolve }))
		const pipeline = createBatchRetryPipeline({
			...options(send), retry: {...options(send).retry, attemptTimeoutMs: 10_000}
		})

		try {
			pipeline.write('first')
			await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
			expect(attemptTimers[0]?.hasRef()).toBe(false)

			const barrier = pipeline.flush()
			expect(attemptTimers[0]?.hasRef()).toBe(true)
			release()
			await barrier
			await pipeline.close()
		} finally {
			timeoutSpy.mockRestore()
		}
	})

	it('does not dispatch a send when its deadline timer cannot be scheduled', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 1_000) throw new Error('timer unavailable')
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const send = vi.fn(async() => undefined)
		const onError = vi.fn()
		try {
			const pipeline = createBatchRetryPipeline({...options(send), telemetry: {onError}})
			pipeline.write('one')
			await pipeline.flush()

			expect(send).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				code: 'DELIVERY_TIMER_UNAVAILABLE', knownNoDelivery: true
			}))
			await pipeline.close()
		} finally { timer.mockRestore() }
	})

	it('contains rejected promises returned as deadline timer handles', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const timerFailure = Promise.reject(new Error('timer rejected'))
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 1_000) return timerFailure as never
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const send = vi.fn(async() => undefined)
		const onError = vi.fn()
		try {
			const pipeline = createBatchRetryPipeline({...options(send), telemetry: {onError}})
			pipeline.write('one')
			await pipeline.flush()

			expect(send).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				code: 'DELIVERY_TIMER_UNAVAILABLE', knownNoDelivery: true
			}))
			await pipeline.close()
			await Promise.resolve()
		} finally { timer.mockRestore() }
	})

	it('does not classify a synchronously elapsed pre-send deadline as physical ambiguity', async() => {
		const originalSetTimeout = globalThis.setTimeout
		const originalClearTimeout = globalThis.clearTimeout
		const send = vi.fn(async() => undefined)
		const onDropped = vi.fn()
		const onError = vi.fn()
		const timer = {ref: vi.fn(), unref: vi.fn()}
		let pipeline: ReturnType<typeof createBatchRetryPipeline<string>> | undefined

		try {
			globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
				callback()
				return timer
			}) as never
			globalThis.clearTimeout = vi.fn() as never
			pipeline = createBatchRetryPipeline({
				...options(send),
				batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 1_000},
				retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 0},
				telemetry: {onDropped, onError}
			})

			pipeline.write('one')
			await pipeline.flush()
		} finally {
			globalThis.setTimeout = originalSetTimeout
			globalThis.clearTimeout = originalClearTimeout
		}

		expect(send).not.toHaveBeenCalled()
		expect(onDropped).toHaveBeenCalledWith(1, 'retry-exhausted')
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			code: 'DELIVERY_TIMEOUT_BEFORE_START',
			knownNoDelivery: true
		}))
		await pipeline?.close()
	})

	it('flushes immediately instead of stranding an admitted batch when scheduling fails', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 1_000) throw new Error('flush timer unavailable')
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const send = vi.fn(async() => undefined)
		const onError = vi.fn()
		try {
			const configured = options(send)
			const pipeline = createBatchRetryPipeline({
				...configured,
				batching: {...configured.batching, maxBatch: 2},
				retry: {...configured.retry, attemptTimeoutMs: 2_000},
				telemetry: {onError}
			})

			expect(() => pipeline.write('one')).not.toThrow()
			await pipeline.flush()
			expect(send).toHaveBeenCalledOnce()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: 'flush timer unavailable'}))
			await pipeline.close()
		} finally { timer.mockRestore() }
	})

	it('does not retain an already-fired autonomous flush handle', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 1_000) {
				Reflect.apply(callback as (...values: unknown[]) => void, undefined, args)
				return {unref: vi.fn()} as never
			}
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const send = vi.fn(async() => undefined)
		try {
			const configured = options(send)
			const pipeline = createBatchRetryPipeline({
				...configured,
				batching: {...configured.batching, maxBatch: 2},
				retry: {...configured.retry, attemptTimeoutMs: 2_000}
			})
			pipeline.write('first')
			await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
			pipeline.write('second')
			await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
			await pipeline.close()
		} finally { timer.mockRestore() }
	})

	it('continues delivery when attempt timer unref fails', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 1_000) return {unref: () => { throw new Error('unref unavailable') }} as never
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const send = vi.fn(async() => undefined)
		try {
			const pipeline = createBatchRetryPipeline(options(send))
			pipeline.write('one')
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(send).toHaveBeenCalledOnce()
			await pipeline.close()
		} finally { timer.mockRestore() }
	})

	it('preserves the attempt deadline when Set.prototype.delete is rewired by the sender', async() => {
		const nativeDelete = Set.prototype.delete
		let replaced = false
		const onError = vi.fn()
		const send = () => new Promise<void>((_resolve, reject) => {
			Object.defineProperty(Set.prototype, 'delete', {
				configurable: true,
				value(this: Set<unknown>, value: unknown) {
					if (value && typeof value === 'object' && 'hasRef' in value) {
						throw new Error('poisoned Set.prototype.delete')
					}
					return Reflect.apply(nativeDelete, this, [value])
				}
			})
			replaced = true
			setTimeout(() => reject(new Error('late sink rejection')), 10)
			setTimeout(() => {
				Object.defineProperty(Set.prototype, 'delete', {
					configurable: true, writable: true, value: nativeDelete
				})
				replaced = false
			}, 20)
		})
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, attemptTimeoutMs: 5},
			telemetry: {onError}
		})

		try {
			pipeline.write('one')
			await pipeline.flush()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				code: 'DELIVERY_TIMEOUT', ambiguousDelivery: true
			}))
		} finally {
			if (replaced) Object.defineProperty(Set.prototype, 'delete', {
				configurable: true, writable: true, value: nativeDelete
			})
		}
		await pipeline.close()
	})

	it('does not retry a timed-out delivery when WeakSet.prototype.add is rewired', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 50) throw new Error('grace timer unavailable')
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const nativeAdd = WeakSet.prototype.add
		let sends = 0
		const sendWithSignal = (_items: readonly string[], signal: AbortSignal) => {
			sends += 1
			Object.defineProperty(WeakSet.prototype, 'add', {
				configurable: true,
				value: () => { throw new Error('poisoned WeakSet.prototype.add') }
			})
			return new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {once: true})
			})
		}
		const pipeline = createBatchRetryPipeline({
			...options(async() => undefined),
			retry: {...options(async() => undefined).retry, maxAttempts: 2, attemptTimeoutMs: 5},
			sendWithSignal
		})

		try {
			pipeline.write('one')
			await expect(pipeline.flush()).rejects.toThrow('timed out')
			expect(sends).toBe(1)
		} finally {
			Object.defineProperty(WeakSet.prototype, 'add', {
				configurable: true, writable: true, value: nativeAdd
			})
			timer.mockRestore()
		}
		await pipeline.close()
	})

	it('preserves successful delivery when timer cleanup fails', async() => {
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
			throw new Error('timer cleanup unavailable')
		})
		const send = vi.fn(async() => undefined)
		try {
			const pipeline = createBatchRetryPipeline(options(send))
			pipeline.write('one')
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(send).toHaveBeenCalledOnce()
			await expect(pipeline.close()).resolves.toBeUndefined()
		} finally { cleanup.mockRestore() }
	})

	it('contains rejected promises returned by timer cleanup', async() => {
		const cleanupFailure = Promise.reject(new Error('timer cleanup rejected'))
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => cleanupFailure as never)
		const send = vi.fn(async() => undefined)
		try {
			const pipeline = createBatchRetryPipeline(options(send))
			pipeline.write('one')
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(send).toHaveBeenCalledOnce()
			await expect(pipeline.close()).resolves.toBeUndefined()
			await Promise.resolve()
		} finally { cleanup.mockRestore() }
	})

	it('detaches timers when cleanup returns asynchronously', async() => {
		const unref = vi.fn()
		const ref = vi.fn()
		const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({unref, ref} as never)
		const cleanupFailure = Promise.reject(new Error('timer cleanup rejected'))
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockReturnValue(cleanupFailure as never)
		try {
			const pipeline = createBatchRetryPipeline(options(async() => undefined))
			pipeline.write('one')
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(unref).toHaveBeenCalled()
			await pipeline.close()
			await Promise.resolve()
		} finally {
			cleanup.mockRestore()
			timer.mockRestore()
		}
	})

	it('completes retry backoff when timer cleanup fails', async() => {
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
			throw new Error('timer cleanup unavailable')
		})
		const send = vi.fn()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(undefined)
		try {
			const configured = options(send)
			const pipeline = createBatchRetryPipeline({
				...configured,
				retry: {...configured.retry, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1}
			})
			pipeline.write('one')
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(send).toHaveBeenCalledTimes(2)
			await expect(pipeline.close()).resolves.toBeUndefined()
		} finally { cleanup.mockRestore() }
	})

	it('continues bounded retries when a backoff timer cannot be scheduled', async() => {
		const nativeSetTimeout = globalThis.setTimeout
		const scheduling = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
			if (ms === 7) throw new Error('backoff timer unavailable')
			return nativeSetTimeout(callback, ms, ...args)
		}) as typeof setTimeout)
		const send = vi.fn()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(undefined)
		try {
			const configured = options(send)
			const pipeline = createBatchRetryPipeline({
				...configured,
				retry: {...configured.retry, maxAttempts: 2, baseDelayMs: 7, maxDelayMs: 7}
			})
			pipeline.write('one')
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(send).toHaveBeenCalledTimes(2)
			await pipeline.close()
		} finally { scheduling.mockRestore() }
	})

	it('retries only the undelivered suffix after a resolved partial acknowledgement', async() => {
		const send = vi.fn(async(items: readonly string[]) => ({
			deliveredCount: items.length === 2 ? 1 : items.length
		}))
		const onSuccess = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send as never),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(async() => {}).retry, maxAttempts: 2},
			telemetry: {onSuccess}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(send.mock.calls.map(([items]) => items)).toEqual([
			['one', 'two'], ['two']
		])
		expect(onSuccess).toHaveBeenNthCalledWith(1, 1)
		expect(onSuccess).toHaveBeenNthCalledWith(2, 1)
		await pipeline.close()
	})

	it('does not let a sender forge deliveredCount through descriptor poisoning', async() => {
		const descriptor = Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')!
		const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
		let attempts = 0
		const observed: string[][] = []
		const send = async(items: readonly string[]) => {
			attempts += 1
			observed.push([...items])
			if (attempts === 1) {
				Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
					configurable: true,
					writable: true,
					value: (target: object, key: PropertyKey) => key === 'deliveredCount'
						? {configurable: true, enumerable: true, value: items.length, writable: true}
						: originalGetOwnPropertyDescriptor(target, key)
				})
				return {deliveredCount: 0}
			}
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 0}
		})

		try {
			pipeline.write('one')
			pipeline.write('two')
			await pipeline.flush()
		} finally {
			Object.defineProperty(Object, 'getOwnPropertyDescriptor', descriptor)
		}

		expect(observed).toEqual([['one', 'two'], ['one', 'two']])
		await pipeline.close()
	})

	it('does not inherit non-retryable delivery markers from Object.prototype', async() => {
		let attempts = 0
		const send = async() => {
			attempts += 1
			if (attempts === 1) throw new Error('transient')
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 1, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 0}
		})

		Object.defineProperty(Object.prototype, 'nonRetryable', {
			configurable: true, writable: true, value: true
		})
		try {
			pipeline.write('one')
			await pipeline.flush()
		} finally {
			delete (Object.prototype as Record<string, unknown>).nonRetryable
		}

		expect(attempts).toBe(2)
		await pipeline.close()
	})

	it('does not replay a delivered prefix from a rejected send without a custom projector', async() => {
		const send = vi.fn(async(items: readonly string[]) => {
			if (items.length === 2) throw Object.assign(new Error('second item failed'), {deliveredCount: 1})
		})
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(send.mock.calls.map(([items]) => items)).toEqual([
			['one', 'two'], ['two']
		])
		await pipeline.close()
	})

	it('does not let success telemetry rewrite an acknowledged retry prefix', async() => {
		const rejection = Object.assign(new Error('second item failed'), {deliveredCount: 1})
		const calls: string[][] = []
		const send = async(items: readonly string[]) => {
			calls.push([...items])
			if (calls.length === 1) throw rejection
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2},
			telemetry: {onSuccess: () => { rejection.deliveredCount = 0 }}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(calls).toEqual([['one', 'two'], ['two']])
		await pipeline.close()
	})

	it('does not let a custom retry projector replay an acknowledged prefix', async() => {
		const send = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('second item failed'), {deliveredCount: 1}))
			.mockResolvedValueOnce(undefined)
		const onSuccess = vi.fn()
		const onDropped = vi.fn()
		const onError = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send),
			batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
			retry: {...options(send).retry, maxAttempts: 2},
			getRetryItems: (_error, attemptedItems) => attemptedItems,
			telemetry: {onSuccess, onDropped, onError}
		})

		pipeline.write('one')
		pipeline.write('two')
		await pipeline.flush()

		expect(send.mock.calls.map(([items]) => items)).toEqual([['one', 'two']])
		expect(onSuccess).toHaveBeenCalledTimes(1)
		expect(onSuccess).toHaveBeenCalledWith(1)
		expect(onDropped).not.toHaveBeenCalled()
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			message: 'Invalid batch retry item projection'
		}))
		await pipeline.close()
	})

	it('does not drop retryable items when Array.prototype.slice is rewired by the sender', async() => {
		const nativeSlice = Array.prototype.slice
		const restore = (): void => {
			Object.defineProperty(Array.prototype, 'slice', {
				configurable: true, writable: true, value: nativeSlice
			})
		}
		let sends = 0
		const send = async() => {
			sends += 1
			if (sends === 1) {
				Object.defineProperty(Array.prototype, 'slice', {
					configurable: true,
					value: () => { restore(); throw new Error('poisoned Array.slice') }
				})
				throw new Error('retryable')
			}
			restore()
		}
		const pipeline = createBatchRetryPipeline({
			...options(send), retry: {...options(send).retry, maxAttempts: 2}
		})

		try {
			pipeline.write('one')
			await pipeline.flush()
			expect(sends).toBe(2)
		} finally { restore() }
		await pipeline.close()
	})

	it.each([3, -1, 1.5])(
		'treats malformed rejected-send deliveredCount %s as ambiguous',
		async(deliveredCount) => {
			const send = vi.fn(async() => {
				throw Object.assign(new Error('malformed acknowledgement'), {deliveredCount})
			})
			const onSuccess = vi.fn()
			const onError = vi.fn()
			const pipeline = createBatchRetryPipeline({
				...options(send),
				batching: {maxBatch: 2, maxBytes: 1_000, maxIntervalMs: 1_000},
				retry: {...options(send).retry, maxAttempts: 2},
				telemetry: {onSuccess, onError}
			})

			pipeline.write('one')
			pipeline.write('two')
			await pipeline.flush()

			expect(send.mock.calls.map(([items]) => items)).toEqual([['one', 'two']])
			expect(onSuccess).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				message: 'Invalid rejected batch retry deliveredCount',
				ambiguousDelivery: true,
				nonRetryable: true
			}))
			await pipeline.close()
		}
	)

	it.each(['accessor', 'inherited', 'proxy'] as const)(
		'treats rejected-send %s acknowledgement metadata as ambiguous',
		async(kind) => {
			const getter = vi.fn(() => 1)
			const descriptorTrap = vi.fn(() => undefined)
			const rejection = kind === 'accessor'
				? Object.defineProperty(new Error('accessor acknowledgement'), 'deliveredCount', {get: getter})
				: kind === 'inherited'
					? Object.create({deliveredCount: 1}) as object
					: new Proxy(new Error('proxied acknowledgement'), {getOwnPropertyDescriptor: descriptorTrap})
			let sends = 0
			const send = async() => {
				sends += 1
				throw rejection
			}
			const onSuccess = vi.fn()
			const onDropped = vi.fn()
			const onError = vi.fn()
			const pipeline = createBatchRetryPipeline({
				...options(send),
				retry: {...options(send).retry, maxAttempts: 3},
				telemetry: {onSuccess, onDropped, onError}
			})

			pipeline.write('one')
			await pipeline.flush()

			expect(sends).toBe(1)
			expect(getter).not.toHaveBeenCalled()
			expect(descriptorTrap).not.toHaveBeenCalled()
			expect(onSuccess).not.toHaveBeenCalled()
			expect(onDropped).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				message: kind === 'proxy'
					? 'Invalid rejected batch retry decision metadata'
					: 'Invalid rejected batch retry deliveredCount',
				ambiguousDelivery: true,
				nonRetryable: true
			}))
			await pipeline.close()
		}
	)

	it.each(['ambiguousDelivery', 'nonRetryable', 'retryable', 'code'] as const)(
		'does not retry accessor-backed rejected-send %s metadata',
		async(field) => {
			const getter = vi.fn(() => field === 'code' ? 'BREAKER_OPEN' : true)
			const rejection = Object.defineProperty(new Error('unsafe retry decision'), field, {get: getter})
			let sends = 0
			const send = async() => {
				sends += 1
				throw rejection
			}
			const onError = vi.fn()
			const onDropped = vi.fn()
			const pipeline = createBatchRetryPipeline({
				...options(send),
				retry: {...options(send).retry, maxAttempts: 3},
				telemetry: {onError, onDropped}
			})

			pipeline.write('one')
			await pipeline.flush()

			expect(sends).toBe(1)
			expect(getter).not.toHaveBeenCalled()
			expect(onDropped).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				message: 'Invalid rejected batch retry decision metadata',
				ambiguousDelivery: true,
				nonRetryable: true
			}))
			await pipeline.close()
		}
	)

	it.each([
		['ambiguousDelivery', 'true'],
		['nonRetryable', 1],
		['retryable', null]
	] as const)(
		'does not retry malformed rejected-send %s metadata',
		async(field, value) => {
			const rejection = Object.assign(new Error('malformed retry decision'), {[field]: value})
			let sends = 0
			const onError = vi.fn()
			const onDropped = vi.fn()
			const pipeline = createBatchRetryPipeline({
				...options(async() => { sends += 1; throw rejection }),
				retry: {...options(async() => undefined).retry, maxAttempts: 3},
				telemetry: {onError, onDropped}
			})

			pipeline.write('one')
			await pipeline.flush()

			expect(sends).toBe(1)
			expect(onDropped).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				message: 'Invalid rejected batch retry decision metadata',
				ambiguousDelivery: true,
				nonRetryable: true
			}))
			await pipeline.close()
		}
	)

	it('does not retry inherited rejected-send decision metadata', async() => {
		const rejection = Object.create({ambiguousDelivery: true}) as object
		let sends = 0
		const onError = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(async() => { sends += 1; throw rejection }),
			retry: {...options(async() => undefined).retry, maxAttempts: 3},
			telemetry: {onError}
		})

		pipeline.write('one')
		await pipeline.flush()

		expect(sends).toBe(1)
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			message: 'Invalid rejected batch retry decision metadata',
			ambiguousDelivery: true,
			nonRetryable: true
		}))
		await pipeline.close()
	})

	it.each(['ambiguousDelivery', 'nonRetryable'] as const)(
		'does not let getRetryItems clear the rejected-send %s decision',
		async(field) => {
			const rejection = Object.assign(new Error('authoritative retry decision'), {[field]: true})
			let sends = 0
			const onDropped = vi.fn()
			const pipeline = createBatchRetryPipeline({
				...options(async() => { sends += 1; throw rejection }),
				retry: {...options(async() => undefined).retry, maxAttempts: 3},
				getRetryItems: (_error, pending) => {
					rejection[field] = false
					return pending
				},
				telemetry: {onDropped}
			})

			pipeline.write('one')
			await pipeline.flush()

			expect(sends).toBe(1)
			if (field === 'ambiguousDelivery') expect(onDropped).not.toHaveBeenCalled()
			else {
				expect(onDropped).toHaveBeenCalledTimes(1)
				expect(onDropped).toHaveBeenCalledWith(1, 'non-retryable')
			}
			await pipeline.close()
		}
	)

	it('does not project or report drops for an ambiguous rejected delivery', async() => {
		const rejection = Object.assign(new Error('outcome unknown'), {ambiguousDelivery: true})
		const getRetryItems = vi.fn(() => ['forged'])
		const onDropped = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(async() => { throw rejection }),
			retry: {...options(async() => undefined).retry, maxAttempts: 3},
			getRetryItems,
			telemetry: {onDropped}
		})

		pipeline.write('one')
		await pipeline.flush()

		expect(getRetryItems).not.toHaveBeenCalled()
		expect(onDropped).not.toHaveBeenCalled()
		await pipeline.close()
	})

	it('fails closed on malformed acknowledgements without asserting a known drop', async() => {
		const malformedSend = vi.fn(async() => ({deliveredCount: 'all'}))
		const onError = vi.fn()
		const onDropped = vi.fn()
		const onSuccess = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(malformedSend as never), noRetry: true,
			telemetry: {onError, onDropped, onSuccess}
		})

		pipeline.write('one')
		await pipeline.flush()

		expect(onSuccess).not.toHaveBeenCalled()
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: 'Invalid batch retry deliveredCount'}))
		expect(onDropped).not.toHaveBeenCalled()
		await pipeline.close()
	})

	it('does not retry a resolved malformed acknowledgement after physical delivery', async() => {
		let sends = 0
		const send = async() => {
			sends += 1
			return {deliveredCount: 'all'} as never
		}
		const onError = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 3},
			telemetry: {onError}
		})

		pipeline.write('one')
		await pipeline.flush()

		expect(sends).toBe(1)
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			message: 'Invalid batch retry deliveredCount',
			ambiguousDelivery: true,
			nonRetryable: true
		}))
		await pipeline.close()
	})

	it.each(['accessor', 'inherited'] as const)(
		'fails closed on resolved %s delivery acknowledgements',
		async(kind) => {
			const getter = vi.fn(() => 0)
			const result = kind === 'accessor'
				? Object.defineProperty({}, 'deliveredCount', {get: getter})
				: Object.create({deliveredCount: 0}) as object
			let sends = 0
			const send = async() => {
				sends += 1
				return result as never
			}
			const onError = vi.fn()
			const onSuccess = vi.fn()
			const onDropped = vi.fn()
			const pipeline = createBatchRetryPipeline({
				...options(send),
				retry: {...options(send).retry, maxAttempts: 3},
				telemetry: {onError, onSuccess, onDropped}
			})

			pipeline.write('one')
			await pipeline.flush()

			expect(sends).toBe(1)
			expect(getter).not.toHaveBeenCalled()
			expect(onSuccess).not.toHaveBeenCalled()
			expect(onDropped).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({
				ambiguousDelivery: true,
				nonRetryable: true
			}))
			await pipeline.close()
		}
	)

	it('rejects proxied delivery results before descriptor or prototype traps', async() => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const getPrototypeOf = vi.fn(() => null)
		const result = new Proxy({deliveredCount: 1}, {getOwnPropertyDescriptor, getPrototypeOf})
		const send = vi.fn(async() => result)
		const onError = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(send as never), noRetry: true, telemetry: {onError}
		})

		pipeline.write('one')
		await pipeline.flush()

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			message: 'Native promise resolved to an unsafe thenable value'
		}))
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
		await pipeline.close()
	})

	it.each(['accessor', 'oversized'] as const)(
		'rejects %s retry projections without replaying forged items',
		async(kind) => {
			const send = vi.fn()
				.mockRejectedValueOnce(Object.assign(new Error('retryable'), {retryable: true}))
				.mockResolvedValueOnce(undefined)
			const projected = kind === 'oversized' ? ['one', 'forged'] : ['one']
			if (kind === 'accessor') {
				Object.defineProperty(projected, '0', {get: () => 'one'})
			}
			const onError = vi.fn()
			const pipeline = createBatchRetryPipeline({
				...options(send),
				retry: {...options(send).retry, maxAttempts: 2},
				getRetryItems: () => projected,
				telemetry: {onError}
			})

			pipeline.write('one')
			await pipeline.flush()

			expect(send).toHaveBeenCalledOnce()
			expect(onError).toHaveBeenCalled()
			await pipeline.close()
		}
	)

	it('preserves retry projection when Map prototype methods are rewired', async() => {
		const nativeGet = Map.prototype.get
		const nativeSet = Map.prototype.set
		const nativeDelete = Map.prototype.delete
		const restore = (): void => {
			Object.defineProperties(Map.prototype, {
				get: {configurable: true, writable: true, value: nativeGet},
				set: {configurable: true, writable: true, value: nativeSet},
				delete: {configurable: true, writable: true, value: nativeDelete}
			})
		}
		let sends = 0
		const send = async() => {
			sends += 1
			if (sends === 1) throw new Error('retryable')
		}
		const getRetryItems = (_error: unknown, pending: readonly string[]) => {
			Object.defineProperties(Map.prototype, {
				get: {configurable: true, value: () => { throw new Error('poisoned Map.get') }},
				set: {configurable: true, value: () => { throw new Error('poisoned Map.set') }},
				delete: {configurable: true, value: () => { throw new Error('poisoned Map.delete') }}
			})
			queueMicrotask(restore)
			return [...pending]
		}
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 2},
			getRetryItems
		})

		try {
			pipeline.write('one')
			await pipeline.flush()
			expect(sends).toBe(2)
		} finally { restore() }
		await pipeline.close()
	})

	it('isolates hostile telemetry and rejects writes after close', async() => {
		const send = vi.fn(async() => {})
		const fail = () => { throw new Error('observer failed') }
		const pipeline = createBatchRetryPipeline({
			...options(send),
			telemetry: {onMark: fail, onDropped: fail, onError: fail, onSuccess: fail}
		})

		pipeline.write('before-close')
		await pipeline.close()
		pipeline.write('after-close')
		await pipeline.flush()

		expect(send).toHaveBeenCalledOnce()
	})

	it('captures telemetry methods without executing accessors or later replacements', async() => {
		const getter = vi.fn(() => vi.fn())
		const accessor = Object.defineProperty({}, 'onMark', {get: getter})
		expect(() => createBatchRetryPipeline({
			...options(async() => {}), telemetry: accessor
		})).toThrow('data methods')
		expect(getter).not.toHaveBeenCalled()

		const original = vi.fn()
		const replacement = vi.fn()
		const telemetry = {onMark: original}
		const pipeline = createBatchRetryPipeline({...options(async() => {}), telemetry})
		telemetry.onMark = replacement
		pipeline.write('one')
		await pipeline.close()

		expect(original).toHaveBeenCalled()
		expect(replacement).not.toHaveBeenCalled()
	})

	it('does not inherit telemetry hooks added to Object.prototype after creation', async() => {
		let calls = 0
		const pipeline = createBatchRetryPipeline({...options(async() => {}), telemetry: {}})
		Object.defineProperties(Object.prototype, {
			onMark: {configurable: true, writable: true, value: () => { calls += 1 }},
			onDropped: {configurable: true, writable: true, value: () => { calls += 1 }},
			onError: {configurable: true, writable: true, value: () => { calls += 1 }},
			onSuccess: {configurable: true, writable: true, value: () => { calls += 1 }}
		})
		try {
			pipeline.write('one')
			await pipeline.close()
		} finally {
			delete (Object.prototype as Record<string, unknown>).onMark
			delete (Object.prototype as Record<string, unknown>).onDropped
			delete (Object.prototype as Record<string, unknown>).onError
			delete (Object.prototype as Record<string, unknown>).onSuccess
		}

		expect(calls).toBe(0)
	})

	it('observes rejected native promises returned by void telemetry hooks', async() => {
		const reject = vi.fn(() => Promise.reject(new Error('observer rejected')))
		const pipeline = createBatchRetryPipeline({
			...options(async() => {}), telemetry: {onMark: reject, onSuccess: reject}
		})

		pipeline.write('one')
		await pipeline.close()
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		expect(reject).toHaveBeenCalled()
	})

	it('contains rejected native promises thrown by void telemetry hooks', async() => {
		const thrown = Promise.reject(new Error('observer threw'))
		const hook = vi.fn(() => { throw thrown })
		const pipeline = createBatchRetryPipeline({
			...options(async() => {}), telemetry: {onMark: hook, onSuccess: hook}
		})

		pipeline.write('one')
		await pipeline.close()
		await Promise.resolve()

		expect(hook).toHaveBeenCalled()
	})

	it('rejects forged and proxied abort signals without executing traps', () => {
		const aborted = vi.fn(() => false)
		const forged = Object.defineProperty({}, 'aborted', {get: aborted})
		expect(() => createBatchRetryPipeline({
			...options(async() => {}), signal: forged as AbortSignal
		})).toThrow('abort signal')
		expect(aborted).not.toHaveBeenCalled()

		const ownKeys = vi.fn(() => [])
		const proxied = new Proxy(new AbortController().signal, {ownKeys})
		expect(() => createBatchRetryPipeline({
			...options(async() => {}), signal: proxied
		})).toThrow('abort signal')
		expect(ownKeys).not.toHaveBeenCalled()
	})

	it('reports a timeout delivery that settles during the abort grace window', async() => {
		const onError = vi.fn()
		const sendWithSignal = vi.fn((_items: readonly string[], signal: AbortSignal) =>
			new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => {
					const pendingAmbiguousDelivery = (signal.reason as {pendingAmbiguousDelivery?: unknown})
						?.pendingAmbiguousDelivery === true
					reject(Object.assign(new Error('aborted after timeout'), {
						ambiguousDelivery: true,
						pendingAmbiguousDelivery
					}))
				}, {once: true})
			})
		)
		const pipeline = createBatchRetryPipeline({
			...options(async() => {}),
			retry: {...options(async() => {}).retry, attemptTimeoutMs: 5},
			sendWithSignal,
			telemetry: {onError}
		})

		pipeline.write('one')
		await pipeline.flush()

		expect(sendWithSignal).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			ambiguousDelivery: true,
			pendingAmbiguousDelivery: false
		}))
		await pipeline.close()
	})

	it('does not retry a generic rejection that arrives after the attempt timed out', async() => {
		const sendWithSignal = vi.fn((_items: readonly string[], signal: AbortSignal) =>
			new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('generic abort')), {once: true})
			})
		)
		const onError = vi.fn()
		const pipeline = createBatchRetryPipeline({
			...options(async() => {}),
			retry: {...options(async() => {}).retry, maxAttempts: 3, attemptTimeoutMs: 5},
			sendWithSignal,
			telemetry: {onError}
		})

		pipeline.write('one')
		await pipeline.flush()

		expect(sendWithSignal).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({
			code: 'DELIVERY_TIMEOUT', ambiguousDelivery: true
		}))
		await pipeline.close()
	})

	it('does not wait indefinitely for a timed-out physical delivery', async() => {
		let settlePhysical!: () => void
		const sendWithSignal = vi.fn(() => new Promise<void>((resolve) => { settlePhysical = resolve }))
		const pipeline = createBatchRetryPipeline({
			...options(async() => {}),
			retry: {...options(async() => {}).retry, attemptTimeoutMs: 5},
			sendWithSignal
		})

		pipeline.write('one')
		await expect(pipeline.flush()).rejects.toMatchObject({
			code: 'DELIVERY_AMBIGUOUS_PENDING',
			ambiguousDelivery: true,
			nonRetryable: true
		})
		expect(sendWithSignal).toHaveBeenCalledOnce()

		settlePhysical()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await expect(pipeline.close()).resolves.toBeUndefined()
	}, 1_000)

	it.each([
		[{deliveredCount: 0}, 'DELIVERY_PARTIAL_LATE'],
		[{deliveredCount: '0'}, undefined]
	] as const)(
		'surfaces a late incomplete acknowledgement %j instead of silently closing',
		async(result, expectedCode) => {
			let settlePhysical!: (result: unknown) => void
			const sendWithSignal = vi.fn(() => new Promise<unknown>((resolve) => {
				settlePhysical = resolve
			}))
			const pipeline = createBatchRetryPipeline({
				...options(async() => {}),
				retry: {...options(async() => {}).retry, attemptTimeoutMs: 5},
				sendWithSignal: sendWithSignal as never
			})

			pipeline.write('one')
			await expect(pipeline.flush()).rejects.toMatchObject({
				code: 'DELIVERY_AMBIGUOUS_PENDING'
			})

			settlePhysical(result)
			await new Promise<void>((resolve) => { setImmediate(resolve) })
			const close = expect(pipeline.close()).rejects
			if (expectedCode) await close.toMatchObject({
				code: expectedCode,
				nonRetryable: true,
				deliveredCount: 0
			})
			else await close.toThrow('Invalid batch retry deliveredCount')
			expect(sendWithSignal).toHaveBeenCalledOnce()
		},
		1_000
	)

	it('credits only the acknowledged prefix before surfacing a late partial delivery', async() => {
		let settlePhysical!: (result: {deliveredCount: number}) => void
		const onSuccess = vi.fn()
		const sendWithSignal = vi.fn(() => new Promise<{deliveredCount: number}>((resolve) => {
			settlePhysical = resolve
		}))
		const configured = options(async() => {})
		const pipeline = createBatchRetryPipeline({
			...configured,
			batching: {...configured.batching, maxBatch: 2},
			retry: {...configured.retry, attemptTimeoutMs: 5},
			sendWithSignal,
			telemetry: {onSuccess}
		})

		pipeline.write('one')
		pipeline.write('two')
		await expect(pipeline.flush()).rejects.toMatchObject({
			code: 'DELIVERY_AMBIGUOUS_PENDING'
		})

		settlePhysical({deliveredCount: 1})
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await expect(pipeline.close()).rejects.toMatchObject({
			code: 'DELIVERY_PARTIAL_LATE',
			deliveredCount: 1
		})
		expect(onSuccess).toHaveBeenCalledOnce()
		expect(onSuccess).toHaveBeenCalledWith(1)
		expect(sendWithSignal).toHaveBeenCalledOnce()
	}, 1_000)

	it('surfaces every late partial delivery accumulated across timed-out batches', async() => {
		const settlePhysical: Array<(result: {deliveredCount: number}) => void> = []
		const sendWithSignal = vi.fn(() => new Promise<{deliveredCount: number}>((resolve) => {
			settlePhysical.push(resolve)
		}))
		const configured = options(async() => {})
		const pipeline = createBatchRetryPipeline({
			...configured,
			retry: {...configured.retry, attemptTimeoutMs: 5},
			sendWithSignal
		})

		pipeline.write('one')
		await expect(pipeline.flush()).rejects.toMatchObject({code: 'DELIVERY_AMBIGUOUS_PENDING'})
		pipeline.write('two')
		await expect(pipeline.flush()).rejects.toMatchObject({code: 'DELIVERY_AMBIGUOUS_PENDING'})

		settlePhysical[0]!({deliveredCount: 0})
		settlePhysical[1]!({deliveredCount: 0})
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await expect(pipeline.close()).rejects.toMatchObject({
			code: 'DELIVERY_AMBIGUOUS_LATE_FAILURES',
			failureCount: 2,
			failures: [
				expect.objectContaining({code: 'DELIVERY_PARTIAL_LATE'}),
				expect.objectContaining({code: 'DELIVERY_PARTIAL_LATE'})
			]
		})
		expect(sendWithSignal).toHaveBeenCalledTimes(2)
	}, 1_000)

	it('surfaces both a late physical failure and its broken durability handler', async() => {
		let rejectPhysical!: (error: unknown) => void
		const deliveryError = new Error('late sink failure')
		const handlerError = new Error('durability handler failure')
		const sendWithSignal = vi.fn(() => new Promise<void>((_resolve, reject) => {
			rejectPhysical = reject
		}))
		const configured = options(async() => {})
		const pipeline = createBatchRetryPipeline({
			...configured,
			retry: {...configured.retry, attemptTimeoutMs: 5},
			sendWithSignal,
			onAmbiguousFailure: () => { throw handlerError }
		})

		pipeline.write('one')
		await expect(pipeline.flush()).rejects.toMatchObject({code: 'DELIVERY_AMBIGUOUS_PENDING'})
		rejectPhysical(deliveryError)
		await new Promise<void>((resolve) => { setImmediate(resolve) })

		await expect(pipeline.close()).rejects.toMatchObject({
			code: 'DELIVERY_AMBIGUOUS_LATE_FAILURES',
			failureCount: 2,
			failures: [deliveryError, handlerError]
		})
		expect(sendWithSignal).toHaveBeenCalledOnce()
	}, 1_000)

	it('contains abort-listener failures from signal-aware integrations', async() => {
		const sendWithSignal = vi.fn((_items: readonly string[], signal: AbortSignal) =>
			new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => {
					throw new Error('abort observer escaped')
				}, {once: true})
				signal.addEventListener('abort', () => reject(signal.reason), {once: true})
			})
		)
		const pipeline = createBatchRetryPipeline({
			...options(async() => {}),
			retry: {...options(async() => {}).retry, attemptTimeoutMs: 5},
			sendWithSignal
		})

		pipeline.write('one')
		await expect(pipeline.flush()).resolves.toBeUndefined()
		expect(sendWithSignal).toHaveBeenCalledOnce()
		await expect(pipeline.close()).resolves.toBeUndefined()
	})

	it('removes parent abort listeners when send throws synchronously', async() => {
		const parent = new AbortController()
		const add = vi.spyOn(parent.signal, 'addEventListener')
		const remove = vi.spyOn(parent.signal, 'removeEventListener')
		const send = vi.fn((_items: readonly string[]): Promise<void> => {
			throw new Error('synchronous sink failure')
		})
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 3},
			signal: parent.signal
		})

		pipeline.write('one')
		await pipeline.flush()

		const addedAbortListeners = add.mock.calls.filter(([type]) => type === 'abort')
		const removedAbortListeners = remove.mock.calls.filter(([type]) => type === 'abort')
		expect(addedAbortListeners).toHaveLength(3)
		expect(removedAbortListeners).toHaveLength(3)
		await pipeline.close()
	})

	it('does not retry an accepted batch when parent listener cleanup fails', async() => {
		const parent = new AbortController()
		Object.defineProperty(parent.signal, 'removeEventListener', {
			configurable: true,
			value: () => { throw new Error('listener cleanup unavailable') }
		})
		const send = vi.fn(async() => undefined)
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 3},
			signal: parent.signal
		})

		pipeline.write('one')
		await expect(pipeline.flush()).resolves.toBeUndefined()
		expect(send).toHaveBeenCalledOnce()
		await pipeline.close()
	})

	it('continues bounded delivery when parent listener registration fails', async() => {
		const parent = new AbortController()
		Object.defineProperty(parent.signal, 'addEventListener', {
			configurable: true,
			value: () => { throw new Error('listener registration unavailable') }
		})
		const send = vi.fn()
			.mockRejectedValueOnce(new Error('retryable'))
			.mockResolvedValueOnce(undefined)
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {
				...options(send).retry,
				maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1
			},
			signal: parent.signal
		})

		pipeline.write('one')
		await expect(pipeline.flush()).resolves.toBeUndefined()
		expect(send).toHaveBeenCalledTimes(2)
		await pipeline.close()
	})

	it('does not start delivery when the parent aborts during listener registration', async() => {
		const parent = new AbortController()
		Object.defineProperty(parent.signal, 'addEventListener', {
			configurable: true,
			value: () => { parent.abort(new Error('shutdown')) }
		})
		const send = vi.fn(async() => undefined)
		const pipeline = createBatchRetryPipeline({
			...options(send),
			signal: parent.signal
		})

		pipeline.write('one')
		await expect(pipeline.flush()).resolves.toBeUndefined()
		expect(send).not.toHaveBeenCalled()
		await pipeline.close()
	})

	it('does not start delivery when the parent aborts while the deadline handle is detached', async() => {
		const parent = new AbortController()
		const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => ({
			unref: () => { parent.abort(new Error('shutdown')) },
			ref: () => undefined
		}) as never)
		const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined)
		const send = vi.fn(async() => undefined)
		try {
			const pipeline = createBatchRetryPipeline({...options(send), signal: parent.signal})
			pipeline.write('one')
			await Promise.resolve()
			await expect(pipeline.flush()).resolves.toBeUndefined()
			expect(send).not.toHaveBeenCalled()
			await pipeline.close()
		} finally {
			cleanup.mockRestore()
			timer.mockRestore()
		}
	})

	it('contains rejected promises returned by parent listener capabilities', async() => {
		const parent = new AbortController()
		const addFailure = Promise.reject(new Error('listener registration rejected'))
		const removeFailure = Promise.reject(new Error('listener cleanup rejected'))
		Object.defineProperties(parent.signal, {
			addEventListener: {configurable: true, value: () => addFailure},
			removeEventListener: {configurable: true, value: () => removeFailure}
		})
		const send = vi.fn()
			.mockRejectedValueOnce(new Error('retryable'))
			.mockResolvedValueOnce(undefined)
		const pipeline = createBatchRetryPipeline({
			...options(send),
			retry: {...options(send).retry, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1},
			signal: parent.signal
		})

		pipeline.write('one')
		await expect(pipeline.flush()).resolves.toBeUndefined()
		expect(send).toHaveBeenCalledTimes(2)
		await pipeline.close()
		await Promise.resolve()
	})

	it('does not trust caller-supplied pending ambiguity without physical tracking', async() => {
		const onError = vi.fn()
		const send = vi.fn(async() => {
			throw Object.assign(new Error('forged pending ambiguity'), {
				ambiguousDelivery: true,
				pendingAmbiguousDelivery: true
			})
		})
		const pipeline = createBatchRetryPipeline({...options(send), telemetry: {onError}})

		pipeline.write('one')
		await pipeline.flush()

		expect(send).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ambiguousDelivery: true}))
		await pipeline.close()
	})
})

describe('createBatchRetryTracking', () => {
	it('preserves the physical failure when its ambiguous failure handler throws', async() => {
		let rejectDelivery!: (error: unknown) => void
		const deliveryError = new Error('late physical failure')
		const handlerError = new Error('durability handler failed')
		const delivery = createNativePromise<void>((_resolve, reject) => { rejectDelivery = reject })
		const tracking = createBatchRetryTracking<string>({
			onAmbiguousFailure: () => { throw handlerError }
		})
		tracking.trackAmbiguousDelivery(delivery, ['one'])

		rejectDelivery(deliveryError)
		await tracking.waitForAmbiguousDeliveries()

		expect(() => tracking.surfaceLateAmbiguousFailure()).toThrow(expect.objectContaining({
			code: 'DELIVERY_AMBIGUOUS_LATE_FAILURES',
			failureCount: 2,
			failures: [deliveryError, handlerError]
		}))
	})

	it('surfaces every late ambiguous failure when multiple deliveries settle together', async() => {
		let rejectFirst!: (error: unknown) => void
		let rejectSecond!: (error: unknown) => void
		const first = new Error('first late failure')
		const second = new Error('second late failure')
		const firstDelivery = createNativePromise<void>((_resolve, reject) => { rejectFirst = reject })
		const secondDelivery = createNativePromise<void>((_resolve, reject) => { rejectSecond = reject })
		const tracking = createBatchRetryTracking<string>({})
		tracking.trackAmbiguousDelivery(firstDelivery, ['one'])
		tracking.trackAmbiguousDelivery(secondDelivery, ['two'])

		rejectFirst(first)
		rejectSecond(second)
		await tracking.waitForAmbiguousDeliveries()

		expect(() => tracking.surfaceLateAmbiguousFailure()).toThrow(expect.objectContaining({
			code: 'DELIVERY_AMBIGUOUS_LATE_FAILURES',
			failureCount: 2,
			failures: [first, second]
		}))
		expect(() => tracking.surfaceLateAmbiguousFailure()).not.toThrow()
	})

	it('surfaces an undefined late rejection reason exactly once', async() => {
		let rejectDelivery!: (error?: unknown) => void
		const delivery = createNativePromise<void>((_resolve, reject) => { rejectDelivery = reject })
		const tracking = createBatchRetryTracking<string>({})
		tracking.trackAmbiguousDelivery(delivery, ['one'])

		rejectDelivery(undefined)
		await tracking.waitForAmbiguousDeliveries()
		let surfaced = false
		try { tracking.surfaceLateAmbiguousFailure() } catch(error) {
			surfaced = true
			expect(error).toBeUndefined()
		}
		expect(surfaced).toBe(true)
		expect(() => tracking.surfaceLateAmbiguousFailure()).not.toThrow()
	})

	it('keeps the ambiguous-delivery barrier attached after Promise and Set rewiring', async() => {
		let resolveDelivery!: () => void
		const delivery = createNativePromise<void>((resolve) => { resolveDelivery = resolve })
		const tracking = createBatchRetryTracking<string>({})
		const nativeThen = Promise.prototype.then
		const nativeDelete = Set.prototype.delete
		let barrier!: Promise<void>
		Object.defineProperty(Promise.prototype, 'then', {
			configurable: true,
			value: () => { throw new Error('poisoned Promise.prototype.then') }
		})
		Object.defineProperty(Set.prototype, 'delete', {
			configurable: true,
			value: () => { throw new Error('poisoned Set.prototype.delete') }
		})
		try {
			tracking.trackAmbiguousDelivery(delivery, ['one'])
			barrier = tracking.waitForAmbiguousDeliveries()
		} finally {
			Object.defineProperty(Promise.prototype, 'then', {
				configurable: true, writable: true, value: nativeThen
			})
		}

		try {
			let settled = false
			void barrier.then(() => { settled = true })
			await Promise.resolve()
			expect(settled).toBe(false)
			resolveDelivery()
			await barrier
			expect(settled).toBe(true)
		} finally {
			Object.defineProperty(Set.prototype, 'delete', {
				configurable: true, writable: true, value: nativeDelete
			})
		}
	}, 1_000)

	it('caps retained abort-ignoring ambiguous deliveries', () => {
		const tracking = createBatchRetryTracking<string>({})
		const never = new Promise<void>(() => undefined)
		for (let index = 0; index < 100; index += 1) {
			expect(tracking.canStartAmbiguousDelivery()).toBe(true)
			tracking.trackAmbiguousDelivery(never, [`item-${index}`])
		}
		expect(tracking.canStartAmbiguousDelivery()).toBe(false)
	})

	it('does not coerce hostile late delivery failures in its rejection continuation', async() => {
		let rejectDelivery!: (error: unknown) => void
		const delivery = new Promise<void>((_resolve, reject) => { rejectDelivery = reject })
		const coercion = vi.fn(() => { throw new Error('coercion escaped') })
		const failure = {[Symbol.toPrimitive]: coercion}
		const tracking = createBatchRetryTracking<string>({})
		tracking.trackAmbiguousDelivery(delivery, ['one'])

		rejectDelivery(failure)
		await tracking.waitForAmbiguousDeliveries()

		expect(coercion).not.toHaveBeenCalled()
		let surfaced: unknown
		try { tracking.surfaceLateAmbiguousFailure() } catch(error) { surfaced = error }
		expect(surfaced).toBe(failure)
	})
})
