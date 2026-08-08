import {URL} from 'node:url'

const decode = decodeURIComponent

const SECRET_KEY_PATTERN = /(?:token|secret|password|authorization|cookie|api[_-]?key|session)/i
const SECRET_KEY_NORMALIZED = /^(?:auth(?:entication)?|p(?:ass(?:wd|phrase)|wd|in)|otp|cvv|privatekey|credentials?)$/
const PII_KEY_NORMALIZED = /^(?:email(?:address)?|phone(?:number)?|ssn|socialsecuritynumber|card(?:number)?|creditcard(?:number)?|username|firstname|lastname|fullname|address|streetaddress|ip(?:address)?|dob|dateofbirth|iban|bankaccount|accountnumber)$/
const UNSAFE_VALUE_PATTERN = /(?:https?:\/\/|[?&][^=]+=|[0-9a-f]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
const EMAIL_VALUE_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const IP_VALUE_PATTERN = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]*)$/i
const PHONE_VALUE_PATTERN = /^(?=(?:\D*\d){7,15}\D*$)\+?[\d\s().-]+$/
const SECRET_VALUE_PATTERN = /(?:bearer\s+|basic\s+|(?:api[_-]?key|token|secret|p(?:ass(?:w(?:or)?d)?|wd|in)|otp|cvv|authorization)\s*[=:]|(?:AKIA|ASIA)[A-Z0-9]{16})/i
const OPAQUE_TOKEN_VALUE_PATTERN = /^(?:[0-9a-f]{24,}|(?=.{32,}$)[A-Za-z0-9+/_-]+={0,2})$/
const JWT_VALUE_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/
const ABSOLUTE_URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i
const SAFE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX_ID_PATTERN = /^[0-9a-f]{12,}$/i
const NUMERIC_ID_PATTERN = /^\d+$/
const MIXED_ID_PATTERN = /^(?=.*\d)[a-z0-9_-]{10,}$/i
const SAFE_PROFILE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/
const KNOWN_PROFILE_REASONS = /^(?:profiling_(?:shutdown|disabled|unavailable)|sampled_out|cooldown_active|capture_(?:in_progress|failed)|profile_too_large)$/

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : value.slice(0, maxLength - 3) + '...'
}

function sanitizeValue(value: string, maxLength: number): string {
	if (value.length > 4_096) return 'redacted'
	for (let index = 0; index < Math.min(value.length, maxLength); index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || code === 127) return 'redacted'
	}
	if (value.startsWith('http://') || value.startsWith('https://')) {
		try {
			const url = new URL(value)
			const pathname = url.pathname || '/'
			return truncate(normalizePath(pathname), maxLength)
		} catch {
			return 'redacted'
		}
	}
	if (ABSOLUTE_URI_PATTERN.test(value)) return 'redacted'
	if (value.startsWith('/')) {
		const pathname = value.split(/[?#]/u, 1)[0] ?? ''
		if (!pathname) return 'redacted'
		const normalized = normalizePath(pathname)
		return UNSAFE_VALUE_PATTERN.test(normalized) ? 'redacted' : truncate(normalized, maxLength)
	}
	if (EMAIL_VALUE_PATTERN.test(value)) {
		return '[email]'
	}
	if (IP_VALUE_PATTERN.test(value)) return '[ip]'
	if (PHONE_VALUE_PATTERN.test(value)) return '[phone]'
	if (SECRET_VALUE_PATTERN.test(value)) {
		return 'redacted'
	}
	if (OPAQUE_TOKEN_VALUE_PATTERN.test(value) || JWT_VALUE_PATTERN.test(value)) {
		return '[token]'
	}
	if (UNSAFE_VALUE_PATTERN.test(value)) {
		try {
			const url = new URL(value)
			const pathname = url.pathname || '/'
			return truncate(normalizePath(pathname), maxLength)
		} catch {
			const pathname = value.split(/[?#]/u, 1)[0] ?? ''
			if (!pathname) return 'redacted'
			const normalized = normalizePath(pathname)
			return UNSAFE_VALUE_PATTERN.test(normalized) ? 'redacted' : truncate(normalized, maxLength)
		}
	}
	return truncate(normalizePath(value), maxLength)
}

function looksLikeId(value: string): boolean {
	return UUID_PATTERN.test(value)
		|| HEX_ID_PATTERN.test(value)
		|| NUMERIC_ID_PATTERN.test(value)
		|| MIXED_ID_PATTERN.test(value)
}

function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function shouldRedactKey(key: string): boolean {
	const normalized = normalizeKey(key)
	return SECRET_KEY_PATTERN.test(key)
		|| SECRET_KEY_NORMALIZED.test(normalized)
		|| PII_KEY_NORMALIZED.test(normalized)
}

function isSensitivePathSegment(value: string): boolean {
	let decoded = value
	for (let depth = 0; depth < 4; depth++) {
		let next: string
		try { next = decode(decoded) } catch { return true }
		if (next === decoded) break
		decoded = next
	}
	return EMAIL_VALUE_PATTERN.test(decoded)
		|| IP_VALUE_PATTERN.test(decoded)
		|| PHONE_VALUE_PATTERN.test(decoded)
		|| SECRET_VALUE_PATTERN.test(decoded)
		|| OPAQUE_TOKEN_VALUE_PATTERN.test(decoded)
		|| JWT_VALUE_PATTERN.test(decoded)
		|| /%[0-9a-f]{2}/iu.test(decoded)
}

function normalizePath(value: string): string {
	if (!value.includes('/')) {
		return isSensitivePathSegment(value) || looksLikeId(value) ? ':id' : value
	}
	return value
		.split('/')
		.map((segment) => isSensitivePathSegment(segment) || looksLikeId(segment) ? ':id' : segment)
		.join('/')
}

export function sanitizeProfileLabels(
	labels: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!labels) {
		return undefined
	}
	const entries: Array<[string, string]> = []
	const seenKeys = new Set<string>()
	let rawEntries: Array<[string, string]>
	try {
		const keys = Reflect.ownKeys(labels)
		if (keys.length > 256) return undefined
		rawEntries = []
		for (const key of keys) {
			if (typeof key !== 'string') continue
			const descriptor = Object.getOwnPropertyDescriptor(labels, key)
			if (descriptor?.enumerable && 'value' in descriptor && typeof descriptor.value === 'string') {
				rawEntries.push([key, descriptor.value])
			}
		}
	} catch {
		return undefined
	}

	for (const [rawKey, rawValue] of rawEntries) {
		if (entries.length >= 16) {
			break
		}
		if (rawKey.length > 1_024 || !SAFE_KEY_PATTERN.test(rawKey)) {
			continue
		}
		const key = truncate(rawKey, 64)
		if (seenKeys.has(key)) continue
		let value: string
		try {
			value = shouldRedactKey(rawKey)
				? 'redacted'
				: sanitizeValue(rawValue, 128)
		} catch {
			continue
		}
		seenKeys.add(key)
		entries.push([key, value])
	}

	return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Keep profile names useful for ordinary operation names while preventing
 * caller-controlled URLs, identifiers, and arbitrary text from becoming
 * profile or exporter dimensions.
 */
export function sanitizeProfileName(name: string | undefined, fallback: string): string {
	if (typeof name !== 'string' || !name) return fallback
	if (name.length > 256) return fallback
	const candidate = name.trim()
	if (!SAFE_PROFILE_NAME_PATTERN.test(candidate)) return fallback
	if (UNSAFE_VALUE_PATTERN.test(candidate) || SECRET_VALUE_PATTERN.test(candidate) || looksLikeId(candidate)) return fallback
	return candidate
}

/**
 * Capture reasons are often supplied by custom profilers. Keep public
 * diagnostics enumerable without allowing arbitrary error text into logs,
 * profile stores, or exporter records.
 */
export function sanitizeProfileReason(reason: string | undefined): string | undefined {
	if (!reason) return undefined
	return KNOWN_PROFILE_REASONS.test(reason) ? reason : 'profile_unavailable'
}
