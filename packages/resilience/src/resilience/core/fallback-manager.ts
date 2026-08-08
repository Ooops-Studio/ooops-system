/**
 * @file Fallback manager - L2/L3 orchestration for fallback strategies.
 * Coordinates with retry engine, circuit breaker, timeout.
 */

import type {
	FallbackStrategy
} from '@ooopsstudio/core/contracts/resilience'

import {isolateUnexpectedThenable} from '../utils/capabilities'
import {getPlainDataDescriptors} from '../utils/data-object'

import type {DegradeLevel, ResilienceOperationContext} from './internal-types'

/**
 * Fallback manager options.
 */
export interface FallbackManagerOptions {

	/** Fallback strategies */
	readonly strategies: readonly FallbackStrategy[]

	/** Optional failure observer for individual fallback handler failures */
	readonly onFailure?: (error: unknown, strategy: FallbackStrategy) => void

}

/**
 * Fallback result.
 */
export interface FallbackResult<T> {

	/** Whether fallback was used */
	readonly used: boolean

	/** Result from fallback (if used) */
	readonly result?: T

	/** Degrade level */
	readonly degradeLevel: DegradeLevel

	/** Error that triggered fallback (if any) */
	readonly error?: unknown

}

/**
 * Create a fallback manager.
 * L2/L3 orchestration - uses engines, doesn't implement pure logic.
 */
export function createFallbackManager<T = unknown>(options: FallbackManagerOptions) {

	const {onFailure} = options
	const inputStrategies = options.strategies
	const lengthDescriptor = Array.isArray(inputStrategies)
		? Object.getOwnPropertyDescriptor(inputStrategies, 'length')
		: undefined
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > 8) {
		throw new Error('[Resilience] fallback strategies must be a bounded array')
	}
	const strategies: FallbackStrategy[] = []
	const seenStrategies = new Set<unknown>()
	for (let index = 0; index < length; index++) {
		const item = Object.getOwnPropertyDescriptor(inputStrategies, String(index))
		if (!item?.enumerable || !('value' in item)) throw new Error('[Resilience] fallback strategies must be a dense data array')
		const strategy = item.value as unknown
		if (seenStrategies.has(strategy)) throw new Error('[Resilience] Duplicate fallback strategy is not allowed')
		seenStrategies.add(strategy)
		const descriptors = getPlainDataDescriptors(strategy, 3)
		if (!descriptors) throw new Error('[Resilience] fallback strategy cannot be inspected safely')
		if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
			|| !['condition', 'handler', 'degradeLevel'].includes(key)
			|| !descriptors[key]?.enumerable
			|| !('value' in descriptors[key]!))
			|| typeof descriptors.condition?.value !== 'function'
			|| typeof descriptors.handler?.value !== 'function'
			|| !['NONE', 'PARTIAL', 'OFFLINE'].includes(descriptors.degradeLevel?.value as string)) {
			throw new Error('[Resilience] fallback strategy is invalid')
		}
		strategies.push(Object.freeze({
			condition: descriptors.condition.value as FallbackStrategy['condition'],
			handler: descriptors.handler.value as FallbackStrategy['handler'],
			degradeLevel: descriptors.degradeLevel!.value as FallbackStrategy['degradeLevel']
		}))
	}
	Object.freeze(strategies)

	function notifyFailure(error: unknown, strategy: FallbackStrategy): void {

		try {
			isolateUnexpectedThenable(onFailure?.(error, strategy))
		} catch {
			// Failure observers are diagnostic and must not stop fallback recovery.
		}

	}

	function matches(strategy: FallbackStrategy, error: unknown): boolean {

		try {
			const candidate = strategy.condition(error)
			isolateUnexpectedThenable(candidate)
			return candidate === true
		} catch(conditionError) {
			notifyFailure(conditionError, strategy)
			return false
		}

	}

	return {

		/**
		 * Try fallback strategies in order.
		 * Returns first successful fallback or throws if all fail.
		 */
		async tryFallback(
			error: unknown,
			_context: ResilienceOperationContext
		): Promise<FallbackResult<T>> {

			if (strategies.length === 0) {
				return {
					used: false,
					degradeLevel: 'NONE'
				}
			}

			// Try each fallback strategy in order
			for (const strategy of strategies) {

				// Check if condition matches
				if (!matches(strategy, error)) {
					continue
				}

				try {

					// Execute fallback handler
					const result = await strategy.handler(error)

					return {
						used: true,
						result: result as T,
						degradeLevel: strategy.degradeLevel,
						error
					}

				} catch(fallbackError) {

					// Fallback failed, try next one
					notifyFailure(fallbackError, strategy)
					continue

				}

			}

			// All fallbacks failed
			return {
				used: false,
				degradeLevel: 'NONE',
				error
			}

		}

	}

}
