import type {FallbackStrategy} from '@ooopsstudio/core/contracts/resilience'
import {ResilienceConfigurationError} from '@ooopsstudio/core/contracts/resilience'

import type {ResilienceFallbackRegistry} from '../public/types'
import {isolateUnexpectedThenable} from '../utils/capabilities'
import {getPlainDataDescriptors} from '../utils/data-object'

export interface CustomFallbackStage {
	readonly names: ReadonlySet<string>
	run<T>(
		name: string,
		primaryError: unknown,
		signal: AbortSignal,
		physical: (operation: () => Promise<T>, signal: AbortSignal) => Promise<T>
	): Promise<T>
}

function sanitizedFailure(role: 'primary' | 'fallback'): Error {
	const code = role === 'primary' ? 'RESILIENCE_PRIMARY_FAILURE' : 'RESILIENCE_FALLBACK_FAILURE'
	return Object.freeze(Object.assign(new Error(`Resilience ${role} operation failed`), {
		name: 'ResilienceOperationError',
		code
	}))
}

export function createCustomFallbackStage(registry: ResilienceFallbackRegistry): CustomFallbackStage {
	const captured = new Map<string, readonly FallbackStrategy[]>()
	const registryDescriptors = getPlainDataDescriptors(registry, 64)
	if (!registryDescriptors) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'fallback registry cannot be inspected safely')
	for (const [name, registryDescriptor] of Object.entries(registryDescriptors)) {
		if (name.length < 1 || name.length > 128 || !registryDescriptor.enumerable || !('value' in registryDescriptor)) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid fallback')
		const strategies = registryDescriptor.value as unknown
		if (!Array.isArray(strategies)) {
			throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid fallback')
		}
		const lengthDescriptor = Object.getOwnPropertyDescriptor(strategies, 'length')
		const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
		if (!Number.isSafeInteger(length) || length < 1 || length > 8) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid fallback')
		const snapshot: FallbackStrategy[] = []
		const seenStrategies = new Set<unknown>()
		for (let index = 0; index < length; index++) {
			const item = Object.getOwnPropertyDescriptor(strategies, String(index))
			if (!item?.enumerable || !('value' in item)) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid fallback')
			const strategy = item.value as unknown
			if (seenStrategies.has(strategy)) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'Duplicate fallback strategy is not allowed')
			seenStrategies.add(strategy)
			const descriptors = getPlainDataDescriptors(strategy, 3)
			if (!descriptors) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid fallback')
			if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !['condition', 'handler', 'degradeLevel'].includes(key) || !descriptors[key]?.enumerable || !('value' in descriptors[key]!))
				|| typeof descriptors.condition?.value !== 'function'
				|| typeof descriptors.handler?.value !== 'function'
				|| !['NONE', 'PARTIAL', 'OFFLINE'].includes(descriptors.degradeLevel?.value as string)) {
				throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid fallback')
			}
			snapshot.push(Object.freeze({
				condition: descriptors.condition.value as FallbackStrategy['condition'],
				handler: descriptors.handler.value as FallbackStrategy['handler'],
				degradeLevel: descriptors.degradeLevel!.value as FallbackStrategy['degradeLevel']
			}))
		}
		captured.set(name, Object.freeze(snapshot))
	}
	return Object.freeze({
		names: new Set(captured.keys()),
		async run<T>(name: string, primaryError: unknown, signal: AbortSignal, physical: (operation: () => Promise<T>, signal: AbortSignal) => Promise<T>): Promise<T> {
			let failed = false
			for (const strategy of captured.get(name) ?? []) {
				try {
					const candidate = strategy.condition(primaryError)
					isolateUnexpectedThenable(candidate)
					if (candidate !== true) continue
				} catch { continue }
				try { return await physical(() => Promise.resolve(strategy.handler(primaryError)) as Promise<T>, signal) }
				catch {
					if (signal.aborted) {
						throw signal.reason === undefined
							? Object.assign(new Error('Resilience operation cancelled'), {name: 'AbortError', code: 'ABORT_ERR'})
							: signal.reason
					}
					failed = true
				}
			}
			if (failed) {
				const primary = sanitizedFailure('primary')
				throw new AggregateError(
					[primary, sanitizedFailure('fallback')],
					'Resilience operation fallback failed',
					{cause: primary}
				)
			}
			throw primaryError
		}
	})
}
