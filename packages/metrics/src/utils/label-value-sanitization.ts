const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu
const LONG_HEX_PATTERN = /^(?=.*\d)[\da-f]{16,}$/iu
const LONG_TOKEN_PATTERN = /^(?=.*\d)[A-Za-z0-9_-]{24,}$/u
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const SECRET_LABEL_KEY_PATTERN = /authorization|auth|token|api_?key|secret|password|passwd|credential|session|cookie|set_cookie|jwt|bearer/iu

export const REDACTED_LABEL_VALUE = '[redacted]'

function isOpaque(segment: string): boolean {
	return UUID_PATTERN.test(segment) || LONG_HEX_PATTERN.test(segment) || LONG_TOKEN_PATTERN.test(segment) || /^\d{4,}$/u.test(segment)
}

function normalizePathLikeValue(value: string): string {
	const [withoutHash] = value.split('#', 1)
	const [withoutQuery] = (withoutHash ?? value).split('?', 1)
	return (withoutQuery ?? value).split('/').map((segment) => segment.length > 0 && isOpaque(segment) ? ':id' : segment).join('/')
}

function normalizeSensitiveLabelValue(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length === 0) return ''
	if (EMAIL_PATTERN.test(trimmed)) return '[email]'
	try {
		const url = new URL(trimmed)
		if (url.protocol === 'http:' || url.protocol === 'https:') return normalizePathLikeValue(url.pathname || '/')
	} catch {
		// Not a full URL; continue with path/token checks.
	}
	if (trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('/')) return normalizePathLikeValue(trimmed)
	return isOpaque(trimmed) ? ':id' : trimmed
}

export function isSecretLikeLabelKey(key: string): boolean {
	return SECRET_LABEL_KEY_PATTERN.test(key)
}

export function sanitizeLabelValue(value: unknown, maxLength = 200): string {
	if (value === null || value === undefined) return ''
	const primitive = typeof value === 'string'
		? value
		: typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol'
			? String(value)
			: undefined
	if (primitive === undefined || primitive.length > METRIC_MAX_RAW_LABEL_VALUE_LENGTH) return REDACTED_LABEL_VALUE
	let result = normalizeSensitiveLabelValue(primitive)
	if (result.length > maxLength) result = result.substring(0, Math.max(0, maxLength - 3)) + '...'
	// Transport encoders own escaping. Keeping the normalized value raw makes
	// sanitization idempotent and prevents Prometheus values from being escaped
	// once here and then a second time by its exposition renderer.
	return result
}
import {METRIC_MAX_RAW_LABEL_VALUE_LENGTH} from '../constants'
