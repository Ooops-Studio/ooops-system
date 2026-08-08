import {createStableHasher} from '@ooopsstudio/core/utils/hashing/stable-hash'

import {CLASSIFICATION_RULES, ERROR_CODE_UNKNOWN} from '../constants'
import type {EnrichedError} from '../types/normalized-error'

const MASK = '[REDACTED]'
const DROP = '[DROPPED]'
const MAX_DEPTH = 8
const MAX_ARRAY_LENGTH = 100
const MAX_OBJECT_ENTRIES = 200
const MAX_DIAGNOSTIC_LENGTH = 1024
const MAX_PUBLIC_STRING_LENGTH = 16_384
const MAX_REDACTION_SCAN_LENGTH = 65_536
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000
const SEVERITY_LEVELS = ['info', 'warn', 'error', 'fatal'] as const
const ERROR_CATEGORIES = [
	'VALIDATION', 'NETWORK', 'CONFIG', 'AUTHENTICATION', 'AUTHORIZATION',
	'RATE_LIMIT', 'TIMEOUT', 'RESOURCE', 'BUSINESS_LOGIC', 'UNKNOWN'
] as const
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const CREDENTIAL_KEYS = new Set([
	'auth',
	'authorization',
	'cookie',
	'setcookie',
	'password',
	'passwd',
	'passphrase',
	'pwd',
	'secret',
	'token',
	'accesstoken',
	'accesskey',
	'refreshtoken',
	'privatekey',
	'apikey',
	'credential',
	'cvv',
	'cvc'
])

const IDENTIFIER_KEYS = new Set([
	'tenant',
	'workspace',
	'account',
	'customer',
	'organization',
	'org',
	'project',
	'session',
	'userid',
	'user',
	'sessionid',
	'accountid',
	'customerid',
	'tenantid',
	'workspaceid',
	'organizationid',
	'orgid',
	'projectid',
	'requestid',
	'correlationid',
	'traceid',
	'spanid'
])

const PII_KEYS = new Set([
	'email',
	'phone',
	'phonenumber',
	'firstname',
	'lastname',
	'fullname',
	'displayname',
	'dateofbirth',
	'birthdate',
	'streetaddress',
	'mailingaddress',
	'billingaddress',
	'shippingaddress',
	'ipaddress',
	'clientip',
	'remoteip',
	'remoteaddress',
	'forwardedfor',
	'ssn',
	'socialsecuritynumber',
	'creditcard',
	'cardnumber',
	'zipcode',
	'postalcode'
])

const EXACT_ONLY_CREDENTIAL_KEYS = new Set(['auth'])
const EXACT_ONLY_IDENTIFIER_KEYS = new Set([
	'user', 'tenant', 'workspace', 'account', 'customer', 'organization', 'org', 'project', 'session'
])
const EXACT_ONLY_PII_KEYS = new Set(['ip', 'dob', 'address'])
const STRUCTURED_IDENTIFIER_KEY = /(?:tenant|workspace|account|customer|organization|org|project|user|session)(?:id|name|slug|key)$/u
const KNOWN_CLASSIFICATION_IDENTIFIERS = new Set([
	ERROR_CODE_UNKNOWN,
	...CLASSIFICATION_RULES.flatMap((rule) => rule.patterns)
])

// redactString rejects inputs above the scan ceiling before these expressions run,
// so unbounded terms here are still bounded by MAX_REDACTION_SCAN_LENGTH.
const ASSIGNMENT_VALUE_PATTERN = "(?:(['\"])(?:\\\\.|[^\\\\\\r\\n])*\\2(?=$|[&\\s,<>}])|['\"][^\\r\\n]*|[^&\\s,\"'<>}]+)"
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(String.raw`["']?\b((?:set[^a-z0-9]+cookie|pass[^a-z0-9]+(?:word|wd|phrase)|(?:api|access|private)[^a-z0-9]+(?:key|token)|client[^a-z0-9]+secret|refresh[^a-z0-9]+token))["']?\s*[=:]\s*${ASSIGNMENT_VALUE_PATTERN}`, 'giu')
const IDENTIFIER_ASSIGNMENT_PATTERN = new RegExp(String.raw`["']?\b((?:(?:tenant|workspace|account|customer|organization|org|project|user|session)(?:[-_\s]?(?:id|name|slug|key))?)|(?:(?:request|correlation|trace|span)(?:[-_\s]?id)?)|(?:first|last|full|display)[-_\s]?name|date[-_\s]?of[-_\s]?birth|birth[-_\s]?date|dob|(?:street|mailing|billing|shipping)[-_\s]?address|email|phone(?:[-_\s]?number)?|(?:client|remote)?[-_\s]?ip(?:[-_\s]?address)?|postal(?:[-_\s]?code)?|zip(?:[-_\s]?code)?)["']?\s*[=:]\s*${ASSIGNMENT_VALUE_PATTERN}`, 'giu')
// Exact patterns above handle human-readable keys containing spaces. Prefixes
// are scanned separately from values so a harmless outer assignment cannot
// consume and hide a nested sensitive one (safe=actorUserId=private).
const COMPOUND_ASSIGNMENT_PREFIX_PATTERN = /["']?\b([a-z][^\t\n\v\f\r =:&,"'<>}]*)["']?\s*[=:]\s*/giu
const ASSIGNMENT_VALUE_ONLY_PATTERN = /(?:(['"])(?:\\.|[^\\\r\n])*\1(?=$|[&\s,<>}])|['"][^\r\n]*|[^&\s,"'<>}]+)/uy
// Authorization and cookie fields commonly contain several comma-, semicolon-,
// or whitespace-delimited credentials. Assignment redaction can safely isolate
// ordinary fields, but stopping after the first token of these headers exposes
// Digest response values, secondary cookies, or multi-part proxy credentials.
// Treat the complete bounded line as one secret-bearing value.
const CREDENTIAL_HEADER_PATTERN = /\b((?:proxy[-_ ]?)?authorization|set[-_ ]?cookie|cookie)[ \t]*[=:][^\r\n]*(?:(?:\r\n?|\n)[ \t]+[^\r\n]*)*/giu
const QUERY_VALUE_PATTERNS = [
	/\/?[A-Za-z0-9._~-]{1,256}\?[^,\s"'<>]*/gu,
	/\b(?:(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,63}|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:\/[^\s"'<>]*)?\?[^\s"'<>]*/giu
] as const
const IPV4_ADDRESS_CANDIDATE_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu
const IPV6_ADDRESS_CANDIDATE_PATTERN = /(?<![0-9a-f:])[0-9a-f:]{2,45}(?![0-9a-f:])/giu

const VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/\b(Bearer|Basic)\s+[^,\s"'<>}]+/giu, `$1 ${MASK}`],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, MASK],
	[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, MASK],
	[/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/gu, MASK],
	[/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,255}\b/gu, MASK],
	[/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu, MASK],
	[/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, DROP],
	[/\b[A-Za-z0-9._~-]{1,64}:[^@\s"'<>]{1,256}@[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\b/gu, DROP],
	[/\/(tenants?|workspaces?|accounts?|customers?|organizations?|orgs?|projects?|users?|sessions?)\/[^/\s"'<>?&#]{1,256}/giu, `/$1/${DROP}`],
	[/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/giu, DROP],
	[/\bwww\.(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s"'<>]*)?/giu, DROP],
	[/\b(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.){2,}[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s"'<>]*)?/giu, DROP],
	[/\b(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?\/[^\s"'<>]*/giu, DROP],
	[/\[DROPPED\](?::\d{1,5})?\/[^\s"'<>]*/gu, DROP],
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, DROP],
	[/\b[0-9a-f]{24,}\b/giu, MASK],
	[/\b[A-Za-z0-9+/=_-]{40,}\b/gu, MASK],
	[/\b\d{3}-\d{2}-\d{4}\b/gu, DROP],
	[/\b(?:\d[ -]*?){13,19}\b/gu, DROP],
	[/\/(Users|home)\/[^/\s:]+/gu, '/$1/[REDACTED]'],
	[/\b[A-Za-z]:\\Users\\[^\\\s:]+/giu, 'C:\\Users\\[REDACTED]']
]

const IDENTIFIER_LIKE_TEXT = /(?:^|[-_.:@])(?:tenant|workspace|account|customer|organization|org|project|user|session)(?:[-_.:@]|$)|\b(?:tenant|workspace|account|customer|organization|project|user|session)[A-Z0-9_]|\b\d{4,}\b/iu

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

function containsSensitiveKey(
	normalized: string,
	candidates: ReadonlySet<string>,
	exactOnly?: ReadonlySet<string>
): boolean {
	for (const candidate of candidates) {
		if (normalized === candidate || (!exactOnly?.has(candidate) && normalized.includes(candidate))) return true
	}
	return false
}

function containsSensitiveMachineText(value: string): boolean {
	return containsSensitiveKey(normalizeKey(value), CREDENTIAL_KEYS, EXACT_ONLY_CREDENTIAL_KEYS)
}

function isCredentialKey(normalized: string): boolean {
	return containsSensitiveKey(normalized, CREDENTIAL_KEYS, EXACT_ONLY_CREDENTIAL_KEYS)
		|| (normalized.includes('auth') && !normalized.includes('author'))
}

function containsIdentifierLikeText(value: string): boolean {
	return IDENTIFIER_LIKE_TEXT.test(value)
}

function isStructuredIdentifierKey(normalized: string): boolean {
	return containsSensitiveKey(normalized, IDENTIFIER_KEYS, EXACT_ONLY_IDENTIFIER_KEYS)
		|| STRUCTURED_IDENTIFIER_KEY.test(normalized)
}

function redactCompoundSensitiveAssignments(value: string): string {
	const output: string[] = []
	let cursor = 0
	for (const match of value.matchAll(COMPOUND_ASSIGNMENT_PREFIX_PATTERN)) {
		const key = match[1]
		if (!key || match.index! < cursor) continue
		const normalized = normalizeKey(key)
		if (!isCredentialKey(normalized) && !isStructuredIdentifierKey(normalized)
			&& !containsSensitiveKey(normalized, PII_KEYS, EXACT_ONLY_PII_KEYS)) continue
		const start = match.index! + match[0].length
		// Sticky matching avoids allocating/copying the remaining string for every
		// assignment, which would make many small fields quadratic near the scan cap.
		ASSIGNMENT_VALUE_ONLY_PATTERN.lastIndex = start
		const assignmentValue = ASSIGNMENT_VALUE_ONLY_PATTERN.exec(value)?.[0]
		if (!assignmentValue) continue
		output.push(value.slice(cursor, start), isCredentialKey(normalized) ? MASK : DROP)
		cursor = start + assignmentValue.length
	}
	if (!cursor) return value
	output.push(value.slice(cursor))
	return output.join('')
}

function isKnownClassificationIdentifier(value: string): boolean {
	return KNOWN_CLASSIFICATION_IDENTIFIERS.has(value)
}

export function isIpAddressLike(value: string): boolean {
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) {
		return value.split('.').every((part) => Number(part) <= 255)
	}
	if (!value.includes(':') || !/^[0-9a-f:.]+$/iu.test(value)) return false
	const doubleColon = value.indexOf('::')
	if (doubleColon !== value.lastIndexOf('::')) return false
	const parts = value.split(':')
	if (doubleColon < 0 && parts.length !== 8) return false
	if (doubleColon >= 0 && parts.length > 9) return false
	let populated = 0
	for (const part of parts) {
		if (!part) continue
		if (part.includes('.')) {
			if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(part)
				|| !part.split('.').every((octet) => Number(octet) <= 255)) return false
			populated += 2
			continue
		}
		if (!/^[0-9a-f]{1,4}$/iu.test(part)) return false
		populated++
	}
	return doubleColon >= 0 ? populated < 8 : populated === 8
}

function safeHash(value: unknown): string {
	if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return MASK
	if (typeof value === 'string' && value.length > MAX_REDACTION_SCAN_LENGTH) return MASK
	try {
		return `hash:${createStableHasher().hash(value)}`
	} catch {
		return MASK
	}
}

function safeArrayLength(value: readonly unknown[]): number | undefined {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
		const length = descriptor && 'value' in descriptor ? descriptor.value : undefined
		return Number.isSafeInteger(length) && length >= 0 ? length : undefined
	} catch {
		return undefined
	}
}

function safeArrayKind(value: object): boolean | undefined {
	try { return Array.isArray(value) } catch { return undefined }
}

function safeFunctionName(value: Function): string {
	let current: object | null = value
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, 'name')
			if (descriptor) {
				return 'value' in descriptor && typeof descriptor.value === 'string'
					? descriptor.value
					: 'unavailable'
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch {
		return 'unavailable'
	}
	return 'anonymous'
}

function isNativeError(value: object): value is Error {
	try { return value instanceof Error } catch { return false }
}

function redactString(value: string): string {
	if (value.length > MAX_REDACTION_SCAN_LENGTH) return '[DROPPED_OVERSIZED]'
	let redacted = value.replace(
		IPV4_ADDRESS_CANDIDATE_PATTERN,
		(candidate) => isIpAddressLike(candidate) ? DROP : candidate
	).replace(
		IPV6_ADDRESS_CANDIDATE_PATTERN,
		(candidate) => isIpAddressLike(candidate) ? DROP : candidate
	).replace(CREDENTIAL_HEADER_PATTERN, `$1=${MASK}`)
	for (const [pattern, replacement] of VALUE_PATTERNS) {
		redacted = redacted.replace(pattern, replacement)
	}
	redacted = redacted.includes('=') || redacted.includes(':')
		? redacted.replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1=${MASK}`)
		: redacted
	if (redacted.includes('=') || redacted.includes(':')) {
		redacted = redacted.replace(IDENTIFIER_ASSIGNMENT_PATTERN, `$1=${DROP}`)
		redacted = redactCompoundSensitiveAssignments(redacted)
	}
	if (redacted.includes('?')) {
		for (const pattern of QUERY_VALUE_PATTERNS) redacted = redacted.replace(pattern, DROP)
	}
	return redacted.length > MAX_PUBLIC_STRING_LENGTH
		? `${redacted.slice(0, MAX_PUBLIC_STRING_LENGTH)}...`
		: redacted
}

function redactByKey(key: string, value: unknown): unknown {
	const normalized = normalizeKey(key)
	if (isCredentialKey(normalized)) return MASK
	if (isStructuredIdentifierKey(normalized)) return safeHash(value)
	if (containsSensitiveKey(normalized, PII_KEYS, EXACT_ONLY_PII_KEYS)) return DROP
	return undefined
}

function safeObjectKey(key: string): string {
	if (FORBIDDEN_OBJECT_KEYS.has(key)) return `field_${safeHash(key).replace(/[^a-z0-9]/giu, '_')}`
	const normalized = normalizeKey(key)
	const knownIdentifierField = isStructuredIdentifierKey(normalized)
	if (key.length <= 64 && /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key)
		&& redactString(key) === key && (knownIdentifierField || !containsIdentifierLikeText(key))) return key
	return `field_${safeHash(key).replace(/[^a-z0-9]/giu, '_')}`
}

interface RedactionBudget {
	nodes: number
	chars: number
}

function chargeOutputString(value: string, budget: RedactionBudget): string {
	if (value.length > budget.chars) {
		budget.chars = 0
		return '[Truncated]'
	}
	budget.chars -= value.length
	return value
}

function boundedString(value: string, budget: RedactionBudget): string {
	if (budget.chars <= 0) return '[Truncated]'
	// Charge the bounded input scan, not only the much smaller redacted output.
	// Otherwise many large credential assignments can repeatedly consume the
	// regex scanner while barely advancing the aggregate character budget.
	const scannedCharacters = value.length <= MAX_REDACTION_SCAN_LENGTH ? value.length : 0
	if (scannedCharacters > budget.chars) {
		budget.chars = 0
		return '[Truncated]'
	}
	const redacted = redactString(value)
	const chargedCharacters = Math.max(scannedCharacters, redacted.length)
	if (chargedCharacters > budget.chars) {
		budget.chars = 0
		return '[Truncated]'
	}
	budget.chars -= chargedCharacters
	return redacted
}

function redactValue(
	value: unknown,
	key: string | undefined,
	seen: WeakSet<object>,
	depth: number,
	budget: RedactionBudget
): unknown {
	if (budget.nodes <= 0) return '[Truncated]'
	budget.nodes--
	if (key) {
		const redactedByKey = redactByKey(key, value)
		if (redactedByKey !== undefined) {
			return typeof redactedByKey === 'string'
				? chargeOutputString(redactedByKey, budget)
				: redactedByKey
		}
	}

	if (typeof value === 'string') return boundedString(value, budget)
	if (typeof value === 'bigint') return boundedString(value.toString(), budget)
	if (typeof value === 'symbol') {
		try { return boundedString(value.toString(), budget) } catch { return MASK }
	}
	if (typeof value === 'function') {
		return boundedString(`[Function:${safeFunctionName(value) || 'anonymous'}]`, budget)
	}
	if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
	if (value === undefined) return null
	if (value === null || typeof value !== 'object') return value
	if (depth >= MAX_DEPTH) return '[MaxDepth]'
	if (seen.has(value)) return '[Circular]'
	seen.add(value)

	if (isNativeError(value)) {
		const errorName = dataProperty(value, 'name')
		const errorMessage = dataProperty(value, 'message')
		const errorStack = dataProperty(value, 'stack')
		const errorCause = dataProperty(value, 'cause')
		const output: Record<string, unknown> = {
			name: typeof errorName === 'string' ? boundedString(errorName, budget) : 'Error',
			message: typeof errorMessage === 'string' ? boundedString(errorMessage, budget) : MASK
		}
		if (typeof errorStack === 'string') output.stack = boundedString(errorStack, budget)
		if (errorCause !== undefined) {
			output.cause = redactValue(errorCause, 'cause', seen, depth + 1, budget)
		}
		seen.delete(value)
		return output
	}

	const arrayKind = safeArrayKind(value)
	if (arrayKind === undefined) {
		seen.delete(value)
		return '[Unserializable]'
	}
	if (arrayKind) {
		const arrayValue = value as readonly unknown[]
		const length = safeArrayLength(arrayValue)
		if (length === undefined) {
			seen.delete(value)
			return '[Unserializable]'
		}
		const output: unknown[] = []
		let index = 0
		for (; index < Math.min(length, MAX_ARRAY_LENGTH) && budget.nodes > 0; index++) {
			let descriptor: PropertyDescriptor | undefined
			try { descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index)) } catch { descriptor = undefined }
			output.push(descriptor && 'value' in descriptor
				? redactValue(descriptor.value, undefined, seen, depth + 1, budget)
				: null)
		}
		if (index < Math.min(length, MAX_ARRAY_LENGTH) || length > MAX_ARRAY_LENGTH) output.push('[Truncated]')
		seen.delete(value)
		return output
	}

	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	let keys: readonly PropertyKey[]
	try { keys = Reflect.ownKeys(value) } catch {
		seen.delete(value)
		return depth === 0 ? MASK : '[Unserializable]'
	}
	let truncated = keys.length > MAX_OBJECT_ENTRIES
	for (const entryKey of keys.slice(0, MAX_OBJECT_ENTRIES)) {
		if (budget.nodes <= 0) { truncated = true; break }
		if (typeof entryKey !== 'string' || entryKey.length === 0 || entryKey.length > 128
			|| FORBIDDEN_OBJECT_KEYS.has(entryKey)) continue
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(value, entryKey) } catch { continue }
		if (!descriptor?.enumerable || !('value' in descriptor)) continue
		const outputKey = safeObjectKey(entryKey)
		if (outputKey.length > budget.chars) {
			budget.chars = 0
			truncated = true
			break
		}
		budget.chars -= outputKey.length
		output[outputKey] = redactValue(descriptor.value, entryKey, seen, depth + 1, budget)
	}
	if (truncated) output.__truncated = true
	seen.delete(value)
	return output
}

export function redactErrorValue(value: unknown): unknown {
	try {
		return redactValue(value, undefined, new WeakSet<object>(), 0, {
			nodes: 2_000,
			chars: 131_072
		})
	} catch {
		return MASK
	}
}

/**
 * Produce a bounded, free-form-safe diagnostic string without relying on the
 * caller's Error implementation. Custom sinks and ports may throw arbitrary
 * values, including objects with unsafe getters.
 */
export function sanitizeErrorDiagnostic(value: unknown): string {
	const redacted = redactErrorValue(value)
	const message = typeof redacted === 'string'
		? redacted
		: redacted && typeof redacted === 'object' &&
			typeof (redacted as {message?: unknown}).message === 'string'
			? (redacted as {message: string}).message
			: MASK
	return message.length > MAX_DIAGNOSTIC_LENGTH
		? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH)}...`
		: message
}

function sanitizeMachineIdentifier(value: unknown, label: string): string | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined
	const knownClassificationIdentifier = (label === 'kind' || label === 'code')
		&& isKnownClassificationIdentifier(value)
	if (redactString(value) !== value
		|| (!knownClassificationIdentifier && (containsSensitiveMachineText(value)
			|| containsIdentifierLikeText(value)))) return `${label}:${safeHash(value)}`
	if (/^[A-Za-z][A-Za-z0-9_.:@-]{0,127}$/u.test(value)) return value
	return `${label}:${safeHash(value)}`
}

export function sanitizeErrorDiagnosticId(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined
	if (redactString(value) !== value || containsSensitiveMachineText(value)
		|| containsIdentifierLikeText(value)) return `id:${safeHash(value)}`
	if (/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(value)) return value
	return `id:${safeHash(value)}`
}

function dataProperty(value: object, key: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch { return undefined }
}

function redactRecord(
	record: Readonly<Record<string, unknown>> | undefined,
	seen: WeakSet<object>,
	budget: RedactionBudget
): Readonly<Record<string, unknown>> | undefined {
	if (!record) return undefined
	let redacted: unknown
	try { redacted = redactValue(record, undefined, seen, 0, budget) } catch { return undefined }
	return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
		? redacted as Readonly<Record<string, unknown>>
		: undefined
}

const REDACTED_ERROR_SNAPSHOTS = new WeakSet<object>()

function freezeRedactedValue(value: unknown, seen = new WeakSet<object>()): void {
	if (!value || typeof value !== 'object' || seen.has(value)) return
	seen.add(value)
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (descriptor && 'value' in descriptor) freezeRedactedValue(descriptor.value, seen)
	}
	Object.freeze(value)
}

export function redactEnrichedError(error: EnrichedError): EnrichedError {
	if (error && typeof error === 'object' && REDACTED_ERROR_SNAPSHOTS.has(error)) return error
	if (!error || typeof error !== 'object') {
		const fallback: EnrichedError = {
			kind: 'UnknownError', message: MASK, severity: 'error', category: 'UNKNOWN', timestamp: 0
		}
		freezeRedactedValue(fallback)
		REDACTED_ERROR_SNAPSHOTS.add(fallback)
		return fallback
	}
	const kind = sanitizeMachineIdentifier(dataProperty(error, 'kind'), 'kind') ?? 'UnknownError'
	const rawMessage = dataProperty(error, 'message')
	const severityValue = dataProperty(error, 'severity')
	const categoryValue = dataProperty(error, 'category')
	const timestampValue = dataProperty(error, 'timestamp')
	const severity = typeof severityValue === 'string' && SEVERITY_LEVELS.includes(severityValue as EnrichedError['severity'])
		? severityValue as EnrichedError['severity']
		: 'error'
	const category = typeof categoryValue === 'string' && ERROR_CATEGORIES.includes(categoryValue as EnrichedError['category'])
		? categoryValue as EnrichedError['category']
		: 'UNKNOWN'
	const timestamp = typeof timestampValue === 'number' && Number.isSafeInteger(timestampValue)
		&& timestampValue >= 0 && timestampValue <= MAX_DATE_TIMESTAMP
		? timestampValue
		: 0
	const stack = dataProperty(error, 'stack')
	const cause = dataProperty(error, 'cause')
	const data = dataProperty(error, 'data')
	const context = dataProperty(error, 'context')
	const code = sanitizeMachineIdentifier(dataProperty(error, 'code'), 'code')
	const source = sanitizeMachineIdentifier(dataProperty(error, 'source'), 'source')
	const id = sanitizeErrorDiagnosticId(dataProperty(error, 'id'))
	const correlationId = sanitizeErrorDiagnosticId(dataProperty(error, 'correlationId'))
	const traceId = sanitizeErrorDiagnosticId(dataProperty(error, 'traceId'))
	const seen = new WeakSet<object>()
	const budget: RedactionBudget = {nodes: 2_000, chars: 131_072}
	const message = typeof rawMessage === 'string' ? boundedString(rawMessage, budget) : MASK
	const safeStack = typeof stack === 'string' && stack ? boundedString(stack, budget) : undefined
	let safeCause: unknown
	if (cause !== undefined) {
		try { safeCause = redactValue(cause, 'cause', seen, 0, budget) } catch { safeCause = MASK }
	}
	const safeData = data && typeof data === 'object'
		? redactRecord(data as Readonly<Record<string, unknown>>, seen, budget)
		: undefined
	const safeContext = context && typeof context === 'object'
		? redactRecord(context as Readonly<Record<string, unknown>>, seen, budget)
		: undefined
	const snapshot: EnrichedError = {
		kind,
		message,
		severity,
		category,
		timestamp,
		...(safeStack ? {stack: safeStack} : {}),
		...(cause !== undefined ? {cause: safeCause} : {}),
		...(safeData ? {data: safeData} : {}),
		...(safeContext ? {context: safeContext} : {}),
		...(code ? {code} : {}),
		...(source ? {source} : {}),
		...(id ? {id} : {}),
		...(correlationId ? {correlationId} : {}),
		...(traceId ? {traceId} : {})
	}
	freezeRedactedValue(snapshot)
	REDACTED_ERROR_SNAPSHOTS.add(snapshot)
	return snapshot
}

/**
 * Derive a new canonical snapshot from an error that has already crossed the
 * redaction boundary. The WeakSet brand, rather than a caller-forgeable string
 * prefix, is what makes repeated internal projections idempotent.
 */
export function deriveRedactedError(
	error: EnrichedError,
	overrides: Pick<EnrichedError, 'category' | 'severity'>
): EnrichedError {
	const canonical = redactEnrichedError(error)
	const derived: EnrichedError = {...canonical, ...overrides}
	freezeRedactedValue(derived)
	REDACTED_ERROR_SNAPSHOTS.add(derived)
	return derived
}

/** Creates a distinct immutable projection without repeating hostile traversal. */
export function projectRedactedError(error: EnrichedError): EnrichedError {
	const canonical = redactEnrichedError(error)
	const projection: EnrichedError = {...canonical}
	freezeRedactedValue(projection)
	REDACTED_ERROR_SNAPSHOTS.add(projection)
	return projection
}
