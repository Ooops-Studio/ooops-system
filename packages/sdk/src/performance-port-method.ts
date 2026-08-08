import type {PerformancePort} from '@ooopsstudio/core/ports/performance'

type PerformanceMethod = (...args: never[]) => unknown

const METRIC_NAME = /^[a-z][\w.-]{0,127}$/i

const capturedMethods = new WeakMap<object, Partial<Record<keyof PerformancePort, PerformanceMethod>>>()

/** Observes genuine Promise rejections without reading an arbitrary `then` field. */
export function ignorePromiseRejection(value: unknown): void {
	try {
		void Reflect.apply(Promise.prototype.then, value, [undefined, () => undefined])
	} catch {
		// Non-Promise return values are ignored without thenable assimilation.
	}
}

/** Captures a stable data-method without invoking user-controlled accessors. */
export function capturePerformanceMethod(
	target: PerformancePort | undefined,
	key: keyof PerformancePort
): PerformanceMethod | undefined {
	if (!target || typeof target !== 'object') return undefined
	try {
		const methods = capturedMethods.get(target) ?? {}
		const cached = methods[key]
		if (cached) return cached
		let owner: object | null = target
		for (let depth = 32; owner && depth--;) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as PerformanceMethod
				let activeCalls = 0
				let methodCalls = 0
				const captured = (...args: never[]): unknown => {
					if (typeof args[0] !== 'string' || !METRIC_NAME.test(args[0])) return undefined
					if (!activeCalls) methodCalls = 0
					if (methodCalls++ >= 100) return undefined
					activeCalls++
					try {
						const result = Reflect.apply(method, target, args)
						ignorePromiseRejection(result)
						return result
					} finally { activeCalls-- }
				}
				methods[key] = captured
				capturedMethods.set(target, methods)
				return captured
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch {
		return undefined
	}
	return undefined
}
