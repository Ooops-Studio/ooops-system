/**
 * @file Coalescing engine - pure L1 logic for request coalescing (SingleFlight).
 * Process-local only: does not coordinate across processes or machines.
 * No observability, no orchestration - pure deduplication logic.
 */

import {AsyncLocalStorage} from 'node:async_hooks'

import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {copyDataDescriptorValues, getPlainDataDescriptors} from '../utils/data-object'

import type {CoalescingConfig, StateIsolationKey} from './internal-types'
import {createIsolationKey} from './state-isolation'
import {MAX_TIMER_DELAY_MS} from './timer-limits'

const MAX_COALESCING_KEYS = 10_000

/**
 * Coalescing entry.
 */
interface CoalescingEntry<T> {

	/** Promise for the operation */
	promise: Promise<T>

}

interface OwnershipContext {
	readonly key: StateIsolationKey
	readonly parent?: OwnershipContext
}

export interface CoalescingResult<T> {

	readonly value: T
	readonly shared: boolean

}

/**
 * Coalescing engine options.
 */
export interface CoalescingEngineOptions {

	/** Clock for time calculations */
	readonly clock: Clock

	/** Coalescing configuration */
	readonly config: CoalescingConfig

}

/**
 * Create a coalescing engine.
 * Pure logic - no observability, no orchestration.
 */
export function createCoalescingEngine<T = unknown>(options: CoalescingEngineOptions) {

	const configDescriptors = getPlainDataDescriptors(options.config)
	if (!configDescriptors) throw new Error('[Resilience] CoalescingConfig must be a plain data object')
	const inputConfig = copyDataDescriptorValues(configDescriptors) as unknown as CoalescingConfig

	// Validate config
	if (!Number.isSafeInteger(inputConfig.maxKeys) || inputConfig.maxKeys < 1 || inputConfig.maxKeys > MAX_COALESCING_KEYS) {
		throw new Error('[Resilience] CoalescingConfig.maxKeys must be a bounded positive safe integer')
	}
	if (!Number.isFinite(inputConfig.ttlMs) || inputConfig.ttlMs <= 0 || inputConfig.ttlMs > MAX_TIMER_DELAY_MS) {
		throw new Error('[Resilience] CoalescingConfig.ttlMs must be a bounded positive number')
	}
	if (!['LRU', 'TTL'].includes(inputConfig.evictionPolicy)) {
		throw new Error('[Resilience] CoalescingConfig.evictionPolicy must be LRU or TTL')
	}
	const config: CoalescingConfig = Object.freeze({
		maxKeys: inputConfig.maxKeys,
		evictionPolicy: inputConfig.evictionPolicy,
		ttlMs: inputConfig.ttlMs
	})

	// Map of keys to promises
	const entries = new Map<StateIsolationKey, CoalescingEntry<T>>()
	const ownership = new AsyncLocalStorage<OwnershipContext>()
	let destroyed = false
	const owns = (key: StateIsolationKey): boolean => {
		let context = ownership.getStore()
		while (context) {
			if (context.key === key) return true
			context = context.parent
		}
		return false
	}
	const guardedResult = (
		key: StateIsolationKey,
		promise: Promise<CoalescingResult<T>>
	): Promise<CoalescingResult<T>> => {
		// A cycle rejection deliberately does not adopt the shared result. Mark
		// that result observed because the owner will usually fail from this guard.
		void promise.catch(() => undefined)
		const source = () => owns(key)
			? Promise.reject<CoalescingResult<T>>(new Error('Coalescing ownership cycle detected'))
			: promise
		const guarded = {
			then: <TResult1 = CoalescingResult<T>, TResult2 = never>(
				onFulfilled?: ((value: CoalescingResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
				onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
			) => source().then(onFulfilled, onRejected),
			catch: <TResult = never>(onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null) =>
				source().catch(onRejected),
			finally: (onFinally?: (() => void) | null) => source().finally(onFinally ?? undefined),
			[Symbol.toStringTag]: 'Promise'
		}
		return guarded as Promise<CoalescingResult<T>>
	}

	return {

		/**
		 * Get or create coalesced promise for key.
		 * If key exists, returns existing promise.
		 * Otherwise creates new promise and stores it.
		 */
		getOrCreate(
			keyBase: string,
			scope: 'tenant' | 'workspace' | 'resource' | 'user',
			id: string,
			factory: () => Promise<T>
		): Promise<CoalescingResult<T>> {
			if (destroyed) return Promise.reject(new Error('Coalescing destroyed'))

			const key = createIsolationKey(keyBase, scope, id)
			// Check if entry exists
			const existing = entries.get(key)
			if (existing) {
				// Entries represent physical work, not completed cache values. Expiring an
				// active promise would start a duplicate while the original still owns the
				// single-flight claim, so even the TTL policy may only affect retained state.
				// Active entries are removed exclusively by their settlement path below.
				const result = existing.promise.then((value) => ({value, shared: true}))
				return owns(key) ? guardedResult(key, result) : result
			}

			// Entries are active promises, so evicting one would break single-flight
			// guarantees. Running the new factory untracked would be equally unsafe:
			// repeated calls for that key could duplicate side effects.
			if (entries.size >= config.maxKeys) {
				return Promise.reject(new Error('Coalescing capacity reached'))
			}

			// Defer invocation until after the claim is installed. A factory may
			// synchronously reenter this engine; that call must observe this owner.
			const parent = ownership.getStore()
			const operationOwnership: OwnershipContext = parent ? {key, parent} : {key}
			const promise = Promise.resolve().then(() => ownership.run(operationOwnership, () => {
				if (destroyed) throw new Error('Coalescing destroyed')
				return factory()
			}))
			const entry: CoalescingEntry<T> = {promise}
			entries.set(key, entry)

			return promise.then((value) => ({value, shared: false})).finally(() => {
				if (entries.get(key) === entry) {
					entries.delete(key)
				}
			})

		},

		/**
		 * Destroy engine - clears all coalescing maps and cancels pending promises.
		 */
		destroy(): void {

			destroyed = true
			entries.clear()

		}

	}

}
