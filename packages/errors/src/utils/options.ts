import type {ErrorHandlerOptions} from '../types/error-handler'

const OPTION_KEYS = [
	'ports', 'sink', 'clock', 'observe', 'rethrow', 'deduplicate',
	'classificationRegistry', 'report', 'defaultSource',
	'flushTimeoutMs', 'shutdownTimeoutMs', 'reportTimeoutMs'
] as const

const PORT_KEYS = ['logger', 'metrics', 'tracer', 'cache', 'lifecycle'] as const

export const DEVELOPMENT_ERROR_OPTION_KEYS = ['clock', 'ports'] as const
export const PRODUCTION_ERROR_OPTION_KEYS = [
	'clock', 'ports', 'sink', 'classificationRegistry', 'observe', 'defaultSource'
] as const
export const CUSTOM_ERROR_OPTION_KEYS = [
	'ports', 'sink', 'clock', 'observe', 'rethrow', 'deduplicate',
	'classificationRegistry', 'report', 'defaultSource',
	'flushTimeoutMs', 'shutdownTimeoutMs', 'reportTimeoutMs'
] as const

function isArrayOrUninspectable(value: unknown): boolean {
	try { return Array.isArray(value) } catch { return true }
}

function snapshotDataProperties(
	value: object,
	keys: readonly PropertyKey[],
	errorCode: string
): Record<PropertyKey, unknown> {
	const snapshot: Record<PropertyKey, unknown> = {}
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		const supported = new Set(keys)
		for (const key of Reflect.ownKeys(value)) {
			if (!supported.has(key)) throw new Error()
		}
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor) continue
			// Accessor-backed or hidden configuration must fail closed. Silently
			// treating a configured sink/clock/port as absent can start production
			// with a materially different runtime than the caller requested.
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			snapshot[key] = descriptor.value
		}
	} catch {
		throw new Error(errorCode)
	}
	return snapshot
}

/**
 * Snapshot only the supported own data properties. This keeps configuration
 * access deterministic and prevents caller-controlled getters or proxy traps
 * from running later during registration, preset composition, or handling.
 */
export function snapshotErrorHandlerOptions<T extends ErrorHandlerOptions>(
	value: T | undefined,
	allowedKeys: readonly PropertyKey[] = OPTION_KEYS
): T {
	if (value === undefined) return {} as T
	if (!value || typeof value !== 'object' || isArrayOrUninspectable(value)) throw new Error('errors_invalid_options')
	const snapshot = snapshotDataProperties(value, allowedKeys, 'errors_invalid_options')
	if (Object.hasOwn(snapshot, 'ports')) {
		const ports = snapshot.ports
		if (ports !== undefined) {
			if (!ports || typeof ports !== 'object' || isArrayOrUninspectable(ports)) throw new Error('errors_invalid_ports')
			snapshot.ports = snapshotDataProperties(ports, PORT_KEYS, 'errors_invalid_ports')
		}
	}
	return snapshot as T
}
