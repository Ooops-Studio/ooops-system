import {isRateLimitProxy} from '../utils/safe-object'

import type {RedisScriptPort} from './engines/redis-scripts'

export function bindRateLimitRedis(redis: RedisScriptPort): RedisScriptPort {
	if (!redis || typeof redis !== 'object' || isRateLimitProxy(redis)) throw new TypeError('Redis rate limit requires a Redis port')
	let current: object | null = redis
	let evaluate: ((script: string, keys: ReadonlyArray<string>, args?: ReadonlyArray<string | number>) => Promise<unknown>) | undefined
	try {
		for (let depth = 0; current && depth < 16; depth++) {
			if (isRateLimitProxy(current)) break
			const descriptor = Object.getOwnPropertyDescriptor(current, 'eval')
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') break
				const method = descriptor.value as typeof evaluate
				evaluate = (script, keys, args) => Reflect.apply(method!, redis, [script, keys, args]) as Promise<unknown>
				break
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { /* rejected below */ }
	if (!evaluate) throw new TypeError('Redis rate limit requires a data-method eval()')
	return Object.freeze({
		eval: <T = unknown>(script: string, keys: ReadonlyArray<string>, args?: ReadonlyArray<string | number>): Promise<T> =>
			evaluate!(script, keys, args) as Promise<T>
	})
}
