export function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 31 || code === 127) return true
	}
	return false
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_.-]{0,63}$/i
const EMAIL_PATTERN = /@/u
const URL_PATTERN = /(?:https?:\/\/|\/|\?)/iu
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const NUMERIC_ID_PATTERN = /^\d{5,}$/u
const OPAQUE_TOKEN_PATTERN = /^[a-z0-9+/_=-]{24,}$/iu
const SENSITIVE_KEY_PATTERN = /(?:authorization|authentication|cookie|credential|password|secret|token|bearer|session[_.-]?id|(?:api|access|private)[_.-]?key)/iu

export const isSensitivePerformanceKey = (value: string): boolean => SENSITIVE_KEY_PATTERN.test(value)

export function sanitizePerformanceEventName(value: string): string {
	return SAFE_IDENTIFIER.test(value) && !hasControlCharacters(value)
		? value
		: 'custom_event'
}

export function sanitizePerformanceLabelValue(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length === 0) return ''
	if (EMAIL_PATTERN.test(trimmed)) return '[email]'
	if (URL_PATTERN.test(trimmed)) return '[url]'
	if (UUID_PATTERN.test(trimmed)) return '[uuid]'
	if (NUMERIC_ID_PATTERN.test(trimmed)) return '[numeric-id]'
	if (OPAQUE_TOKEN_PATTERN.test(trimmed)) return '[opaque]'
	return trimmed.length <= 64 && !hasControlCharacters(trimmed) ? trimmed : '[redacted]'
}

/** Captures bounded, plain label data without invoking user accessors. */
export function snapshotPerformanceLabels(
	labels: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (labels === undefined) return undefined
	try {
		if (!labels || typeof labels !== 'object' || isRuntimeProxy(labels) || Array.isArray(labels)) throw new TypeError()
		const prototype = Object.getPrototypeOf(labels)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const snapshot: Record<string, string> = Object.create(null) as Record<string, string>
		let inspected = 0
		for (const key in labels) {
			if (inspected >= 32) throw new TypeError()
			const descriptor = Object.getOwnPropertyDescriptor(labels, key)
			if (!descriptor) throw new TypeError()
			inspected += 1
			if (!descriptor.enumerable || !('value' in descriptor) ||
				!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(key) ||
				typeof descriptor.value !== 'string' || descriptor.value.length > 256) {
				throw new TypeError()
			}
			snapshot[key] = descriptor.value
		}
		return snapshot
	} catch {
		throw new Error('Performance event labels exceed safe key/value limits')
	}
}
import {isRuntimeProxy} from './safe-object'
