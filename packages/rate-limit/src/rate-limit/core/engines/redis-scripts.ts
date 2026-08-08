import type {RateLimitEngineResult} from '../../types/engine'
import {isRateLimitProxy} from '../../utils/safe-object'
import {RateLimitBackendError} from '../backend-error'

export {RateLimitBackendError, isRateLimitBackendError} from '../backend-error'

const MAX_REDIS_SCRIPT_RESULT_BYTES = 4_096

/** The only Redis capability rate-limit engines are allowed to retain. */
export interface RedisScriptPort {
	eval<T = unknown>(
		script: string,
		keys: ReadonlyArray<string>,
		args?: ReadonlyArray<string | number>
	): Promise<T>
}

/** Preserve the validated atomic Redis capability across caller mutation. */
export function snapshotRedisScriptPort(redis: RedisScriptPort, engineName: string): RedisScriptPort {
	if (!redis || isRateLimitProxy(redis)) throw new Error(`${engineName} Redis engine requires eval()`)
	let current: object | null = redis
	let evaluate: RedisScriptPort['eval'] | undefined
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			if (isRateLimitProxy(current)) break
			const descriptor = Object.getOwnPropertyDescriptor(current, 'eval')
			if (descriptor) {
				if ('value' in descriptor && typeof descriptor.value === 'function') evaluate = descriptor.value as RedisScriptPort['eval']
				break
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { /* rejected below */ }
	if (!evaluate) throw new Error(`${engineName} Redis engine requires eval()`)
	return Object.freeze({
		eval: <T = unknown>(script: string, keys: ReadonlyArray<string>, args?: ReadonlyArray<string | number>) =>
			Reflect.apply(evaluate!, redis, [script, keys, args]) as Promise<T>
	})
}

function projectScriptRateLimitResult(value: unknown): RateLimitEngineResult | undefined {
	if (!value || typeof value !== 'object' || isRateLimitProxy(value) || Array.isArray(value)) return undefined
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		const allowedKeys = new Set(['allowed', 'remaining', 'resetAt', 'retryAt'])
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowedKeys.has(key))) return undefined
		const descriptors = Object.getOwnPropertyDescriptors(value)
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) return undefined
		const allowed = descriptors.allowed?.value
		const remaining = descriptors.remaining?.value
		const resetAt = descriptors.resetAt?.value
		const retryAt = descriptors.retryAt?.value
		if (
			typeof allowed !== 'boolean' ||
			!Number.isSafeInteger(remaining) ||
			!Number.isSafeInteger(resetAt) ||
			(retryAt !== undefined && !Number.isSafeInteger(retryAt))
		) return undefined
		return {allowed, remaining, resetAt, ...(retryAt !== undefined ? {retryAt} : {})}
	} catch { return undefined }
}

export async function runRedisRateLimitScript(
	redis: RedisScriptPort,
	script: string,
	keys: ReadonlyArray<string>,
	args: ReadonlyArray<string | number>
): Promise<RateLimitEngineResult> {
	if (!redis.eval) throw new Error('Redis port is required to implement eval() for atomic script-based rate limiting')
	let raw: unknown
	try {
		raw = await redis.eval<unknown>(script, keys, args)
	} catch(error) {
		throw new RateLimitBackendError('Redis rate limit script execution failed', {cause: error})
	}
	if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > MAX_REDIS_SCRIPT_RESULT_BYTES) {
		throw new RateLimitBackendError('Redis rate limit script returned an oversized result payload')
	}
	let parsed: unknown
	try {
		parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
	} catch(error) {
		throw new RateLimitBackendError('Redis rate limit script returned an invalid result payload', {cause: error})
	}
	const result = projectScriptRateLimitResult(parsed)
	if (!result) throw new RateLimitBackendError('Redis rate limit script returned an invalid result payload')
	return result
}

export function assertRedisRateLimitResult(
	result: RateLimitEngineResult,
	options: {engineName: string; limit: number; now: number}
): void {
	if (!Number.isSafeInteger(result.remaining) || result.remaining < 0 || result.remaining > options.limit) {
		throw new RateLimitBackendError(`${options.engineName} Redis engine invariant violation: remaining=${result.remaining}, limit=${options.limit}`)
	}
	if (!Number.isSafeInteger(result.resetAt) || result.resetAt < options.now) {
		throw new RateLimitBackendError(`${options.engineName} Redis engine invariant violation: resetAt=${result.resetAt} must be >= now=${options.now}`)
	}
	if (result.retryAt !== undefined &&
		(!Number.isSafeInteger(result.retryAt) || result.retryAt < options.now)) {
		throw new RateLimitBackendError(`${options.engineName} Redis engine invariant violation: retryAt must be at or after now`)
	}
}
