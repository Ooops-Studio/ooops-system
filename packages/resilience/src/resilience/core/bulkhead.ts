/**
 * @file Bulkhead engine - pure L1 logic for concurrency and queue isolation.
 * No observability, no orchestration - pure concurrency control.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {isolateUnexpectedThenable} from '../utils/capabilities'
import {copyDataDescriptorValues, getPlainDataDescriptors} from '../utils/data-object'

import {createBulkheadStore} from './bulkhead-store'
import {BulkheadQueueError, type BulkheadResult} from './bulkhead-types'
import type {BulkheadConfig} from './internal-types'
import {createIsolationKey} from './state-isolation'
import {isSafeTimerDelay, MAX_TIMER_DELAY_MS} from './timer-limits'

const MAX_BULKHEAD_CAPACITY = 10_000
const MAX_BULKHEAD_TOTAL_CLAIMS = 10_000

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
	try { if (timer !== undefined) clearTimeout(timer) } catch { /* cleanup is best effort */ }
}

/**
 * Bulkhead engine options.
 */
export interface BulkheadEngineOptions {

	/** Bulkhead configuration */
	readonly config: BulkheadConfig

	/** Clock for queue inspection timestamps */
	readonly clock: Clock

	/** Maximum distinct active isolation buckets retained at once. */
	readonly maxBuckets?: number

}

export type {BulkheadResult} from './bulkhead-types'

/**
 * Create a bulkhead engine.
 * Pure logic - no observability, no orchestration.
 */
export function createBulkheadEngine(options: BulkheadEngineOptions) {

	const {maxBuckets = 10_000} = options
	const configDescriptors = getPlainDataDescriptors(options.config)
	if (!configDescriptors) throw new Error('[Resilience] BulkheadConfig must be a plain data object')
	const inputConfig = copyDataDescriptorValues(configDescriptors) as unknown as BulkheadConfig

	// Validate config
	if (!Number.isSafeInteger(inputConfig.maxConcurrent) || inputConfig.maxConcurrent < 1 || inputConfig.maxConcurrent > MAX_BULKHEAD_CAPACITY) {
		throw new Error('[Resilience] BulkheadConfig.maxConcurrent must be a bounded positive safe integer')
	}
	if (!Number.isSafeInteger(inputConfig.maxQueueSize) || inputConfig.maxQueueSize < 0 || inputConfig.maxQueueSize > MAX_BULKHEAD_CAPACITY) {
		throw new Error('[Resilience] BulkheadConfig.maxQueueSize must be a bounded non-negative safe integer')
	}
	if (inputConfig.queueTimeoutMs !== undefined && !isSafeTimerDelay(inputConfig.queueTimeoutMs)) {
		throw new Error(`[Resilience] BulkheadConfig.queueTimeoutMs must be > 0 and <= ${MAX_TIMER_DELAY_MS}`)
	}
	if (!['reject', 'drop-oldest', 'degrade'].includes(inputConfig.overflowStrategy)) {
		throw new Error('[Resilience] BulkheadConfig.overflowStrategy must be reject, drop-oldest, or degrade')
	}
	if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1 || maxBuckets > MAX_BULKHEAD_CAPACITY) {
		throw new Error('[Resilience] Bulkhead maxBuckets must be a bounded positive safe integer')
	}
	const config: BulkheadConfig = Object.freeze({
		maxConcurrent: inputConfig.maxConcurrent,
		maxQueueSize: inputConfig.maxQueueSize,
		overflowStrategy: inputConfig.overflowStrategy,
		...(inputConfig.queueTimeoutMs !== undefined ? {queueTimeoutMs: inputConfig.queueTimeoutMs} : {})
	})

	const store = createBulkheadStore(config.maxConcurrent, maxBuckets)
	let destroyed = false
	let totalClaims = 0

	return {

		/**
		 * Acquire permit for operation.
		 * Returns promise that resolves when permit is available.
		 */
		async acquire(
			bucketName: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string,
			options?: {signal?: AbortSignal}
		): Promise<BulkheadResult> {
			if (destroyed) throw new Error('Bulkhead destroyed')
			let signal: AbortSignal | undefined
			if (options !== undefined) {
				const descriptors = getPlainDataDescriptors(options, 1)
				if (!descriptors || Object.keys(descriptors).some((key) => key !== 'signal')) {
					throw new Error('[Resilience] Bulkhead acquire options must be a plain data object')
				}
				signal = descriptors.signal?.value as AbortSignal | undefined
			}

			if (signal?.aborted) {
				throw new Error('Bulkhead acquire cancelled')
			}
			if (destroyed) throw new Error('Bulkhead destroyed')
			const key = createIsolationKey(bucketName, scope, id)
			const bucket = store.getOrCreate(key)
			if (!bucket) {
				return {allowed: false, bucket: bucketName, reason: 'Bulkhead bucket capacity reached'}
			}
			const issuePermit = (): symbol => {
				const permit = Symbol('bulkhead-permit')
				bucket.permits.add(permit)
				return permit
			}

			// Check if we can execute immediately
			if (bucket.active < config.maxConcurrent) {
				if (totalClaims >= MAX_BULKHEAD_TOTAL_CLAIMS) {
					store.removeIfIdle(key, bucket)
					return {allowed: false, bucket: bucketName, reason: 'Bulkhead global capacity reached'}
				}
				bucket.active++
				totalClaims++
				return {
					allowed: true,
					bucket: bucketName,
					permit: issuePermit()
				}
			}

			// Check queue capacity
			if (bucket.queue.length >= config.maxQueueSize) {

				// Handle overflow
				switch (config.overflowStrategy) {
					case 'reject': {
						store.removeIfIdle(key, bucket)
						return {
							allowed: false,
							bucket: bucketName,
							reason: 'Queue full, rejecting'
						}
					}
					case 'drop-oldest': {
						// Remove oldest item from queue
						const oldest = bucket.queue.shift()
						if (oldest) {
							oldest.reject(new BulkheadQueueError('drop-oldest'))
						} else {
							return {
								allowed: false,
								bucket: bucketName,
								reason: 'Queue full, dropping newest'
							}
						}
						// Fall through to add to queue
						break
					}
					case 'degrade': {
						store.removeIfIdle(key, bucket)
						return {
							allowed: false,
							bucket: bucketName,
							reason: 'Queue full, degrading',
							action: 'degrade'
						}
					}
				}

			}

			if (totalClaims >= MAX_BULKHEAD_TOTAL_CLAIMS) {
				store.removeIfIdle(key, bucket)
				return {allowed: false, bucket: bucketName, reason: 'Bulkhead global capacity reached'}
			}

			// Add to queue
			return new Promise<BulkheadResult>((resolve, reject) => {

				if (signal?.aborted) {
					reject(new Error('Bulkhead acquire cancelled'))
					return
				}

				let settled = false
				let timeoutId: ReturnType<typeof setTimeout> | undefined
				const removeAbortListener = () => {
					try { isolateUnexpectedThenable(signal?.removeEventListener?.('abort', onAbort)) } catch { /* cleanup is best effort */ }
				}

				const queuedItem = {
					resolve: () => {
						if (settled) {
							return
						}
						settled = true
						clearTimer(timeoutId)
						removeAbortListener()
						resolve({
							allowed: true,
							bucket: bucketName,
							permit: issuePermit()
						})
					},
					reject: (error: unknown) => {
						if (settled) {
							return
						}
						settled = true
						clearTimer(timeoutId)
						removeAbortListener()
						totalClaims--
						reject(error)
					}
				}

				const removeQueuedItem = () => {
					const index = bucket.queue.indexOf(queuedItem)
					if (index >= 0) {
						bucket.queue.splice(index, 1)
					}
					store.removeIfIdle(key, bucket)
				}

				const onAbort = () => {
					removeQueuedItem()
					queuedItem.reject(new Error('Bulkhead acquire cancelled'))
				}

				bucket.queue.push(queuedItem)
				totalClaims++
				if (config.queueTimeoutMs !== undefined) {
					try {
						timeoutId = setTimeout(() => {
							removeQueuedItem()
							queuedItem.reject(new BulkheadQueueError('queue-timeout'))
						}, config.queueTimeoutMs)
					} catch(error) {
						removeQueuedItem()
						queuedItem.reject(error)
						return
					}
				}
				if (settled) return
				if (signal) {
					try {
						if (isolateUnexpectedThenable(signal.addEventListener('abort', onAbort, {once: true}))) {
							throw new Error('[Resilience] AbortSignal.addEventListener must complete synchronously')
						}
						if (signal.aborted) onAbort()
					} catch {
						removeQueuedItem()
						queuedItem.reject(new Error('Bulkhead cancellation listener failed'))
					}
				}

			})

		},

		/**
		 * Release permit after operation completes.
		 */
		release(
			bucketName: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string,
			permit: symbol
		): void {
			if (destroyed) return

			const key = createIsolationKey(bucketName, scope, id)
			const bucket = store.buckets.get(key)

			if (!bucket) {
				return
			}

			if (typeof permit !== 'symbol' || !bucket.permits.delete(permit)) return
			bucket.active = Math.max(0, bucket.active - 1)
			totalClaims--

			// Process queue
			store.admitQueued(bucket)
			store.removeIfIdle(key, bucket)

		},

		/**
		 * Destroy engine - shuts down all semaphores and clears queues.
		 */
		destroy(): void {

			destroyed = true
			store.destroy('Bulkhead destroyed')
			totalClaims = 0

		}

	}

}
