import type {Clock} from '@ooopsstudio/core/contracts/clock'

/** Capture a callable boundary once without invoking accessor-backed properties. */
export function captureAuditCapability<TArguments extends unknown[], TResult>(
	target: unknown,
	key: PropertyKey
): ((...arguments_: TArguments) => TResult) | undefined {
	if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return undefined
	try {
		let owner: object | null = target
		for (let depth = 0; owner && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...arguments_: TArguments) => TResult
				return (...arguments_: TArguments) => Reflect.apply(method, target, arguments_)
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

export function captureAuditClock(clock: unknown): Clock {
	const now = captureAuditCapability<[], number>(clock, 'now')
	if (!now) throw new Error('Audit clock must provide a readable now() method.')
	return Object.freeze({now})
}
