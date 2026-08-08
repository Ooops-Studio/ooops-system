import {types} from 'node:util'

export const isRateLimitProxy = types.isProxy as (value: unknown) => boolean
export const isRateLimitPromise = types.isPromise as (value: unknown) => boolean

export function ignoreRateLimitPromiseRejection(value: unknown): void {
	if (!isRateLimitPromise(value)) return
	try { void Reflect.apply(Promise.prototype.then, value, [undefined, () => undefined]) } catch { /* best effort */ }
}
