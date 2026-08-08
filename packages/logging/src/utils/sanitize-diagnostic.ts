import {redactString} from '../core/redacting-utilities'

import {readLoggingDataProperty} from './capabilities'
import {sanitizeUrlForDiagnostics} from './sanitize-url'

const MAX_DIAGNOSTIC_LENGTH = 512

export function sanitizeLoggingDiagnostic(value: unknown): string {
	let text: string
	try {
		if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
			return '[unavailable]'
		}
		text = typeof value === 'string' ? value : String(value)
	} catch {
		return '[unavailable]'
	}
	text = redactString(text)
		.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => sanitizeUrlForDiagnostics(url))
		.replace(/\bbearer\s+[a-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
		.replace(/\bbasic\s+[a-z0-9+/]+=*/giu, 'Basic [REDACTED]')
		.replace(/\b([a-z0-9_-]*(?:api[-_ ]?key|authorization|cookie|set[-_ ]?cookie|token|secret|password|session[-_ ]?id|phone|credit[-_ ]?card|card[-_ ]?number|cvv|access[-_ ]?token|refresh[-_ ]?token))(["']?)(\s*[:=]\s*)(["'])[^"'\r\n]*\4/giu, '$1$2$3$4[REDACTED]$4')
		.replace(/\b([a-z0-9_-]*(?:api[-_ ]?key|authorization|cookie|set[-_ ]?cookie|token|secret|password|session[-_ ]?id|phone|credit[-_ ]?card|card[-_ ]?number|cvv|access[-_ ]?token|refresh[-_ ]?token))(["']?)(\s*[:=]\s*)[^&\s"'<>},;]+/giu, '$1$2$3[REDACTED]')
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[REDACTED_EMAIL]')
		.replace(/\b\d{3}-\d{2}-\d{4}\b/gu, '[REDACTED_SSN]')
		.replace(/\b(?:\d[ -]*?){13,19}\b/gu, '[REDACTED_CARD]')
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[REDACTED_IP]')
		.replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/giu, '[REDACTED_IP]')
		.replace(/[\r\n\t]+/gu, ' ')
		.trim()
	if (text.length <= MAX_DIAGNOSTIC_LENGTH) return text
	return `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
}

/** Extract an Error-like message without invoking getters or custom conversion. */
export function sanitizeLoggingErrorDiagnostic(value: unknown): string {
	if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
		const message = readLoggingDataProperty<unknown>(value, 'message')
		return typeof message === 'string' ? sanitizeLoggingDiagnostic(message) : '[unavailable]'
	}
	return sanitizeLoggingDiagnostic(value)
}

/** Return a stable, non-sensitive error classification for public status. */
export function sanitizeLoggingFailureCode(value: unknown, fallback = 'LOGGING_SINK_FAILURE'): string {
	const candidate = readLoggingDataProperty<unknown>(value, 'code')
	if (typeof candidate !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(candidate)) return fallback
	return candidate
}
