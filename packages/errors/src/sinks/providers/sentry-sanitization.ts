import {simpleHash} from '@ooopsstudio/core/utils/hashing/simple-hash'

import {CLASSIFICATION_RULES, ERROR_CODE_UNKNOWN} from '../../constants'
import {isIpAddressLike, redactErrorValue} from '../../utils/redaction'

const MAX_EXTRA_DEPTH = 8
const MAX_OBJECT_ENTRIES = 100
const MAX_STRING_LENGTH = 4096
const MAX_EXTRA_NODES = 2_000
const MAX_EXTRA_CHARACTERS = 131_072
const LOW_CARDINALITY_TAGS = new Set(['category', 'severity', 'environment', 'release'])
const SAFE_SOURCE_TAGS = new Set(['errors', 'production', 'development', '@ooopsstudio/errors'])
const SAFE_ERROR_CODES = new Set([
	ERROR_CODE_UNKNOWN,
	...CLASSIFICATION_RULES.flatMap((rule) => rule.patterns)
		.filter((pattern) => /^[A-Z][A-Z0-9_]{0,63}$/u.test(pattern))
])
const SENSITIVE_NORMALIZED_KEYS = [
	'authorization', 'cookie', 'setcookie', 'token', 'secret', 'password', 'passwd',
	'passphrase', 'pwd', 'apikey', 'accesskey', 'privatekey', 'credential', 'cvv', 'cvc'
] as const
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const IDENTIFIER_TAG_KEY = /^(tenant|workspace|account|customer|org|organization|project|user|email|session|request|trace|correlation)(id|name|slug|key)?$/iu
const COMPOUND_IDENTIFIER_KEYS = [
	'tenantid', 'tenantname', 'tenantslug', 'tenantkey',
	'workspaceid', 'workspacename', 'workspaceslug', 'workspacekey',
	'accountid', 'accountname', 'accountslug', 'accountkey',
	'customerid', 'customername', 'customerslug', 'customerkey',
	'organizationid', 'organizationname', 'organizationslug', 'organizationkey',
	'orgid', 'orgname', 'orgslug', 'orgkey',
	'projectid', 'projectname', 'projectslug', 'projectkey',
	'userid', 'username', 'userslug', 'userkey',
	'sessionid', 'sessionname', 'sessionslug', 'sessionkey',
	'requestid', 'traceid', 'correlationid', 'spanid'
] as const
const SANITIZED_SENTRY_TAGS = new WeakSet<object>()
const IDENTIFIER_EXTRA_KEY = /(?:^|[-_.])(?:tenant|workspace|account|customer|org|organization|project|user|session)(?:[-_.]|$)|(?:tenant|workspace|account|customer|organization|project|user|session)[A-Z]/u
const PII_NORMALIZED_KEYS = new Set([
	'firstname', 'lastname', 'fullname', 'displayname', 'dateofbirth', 'birthdate', 'dob',
	'address', 'streetaddress', 'mailingaddress', 'billingaddress', 'shippingaddress',
	'ip', 'ipaddress', 'clientip', 'remoteip', 'remoteaddress', 'forwardedfor',
	'email', 'phone', 'phonenumber', 'ssn', 'socialsecuritynumber',
	'creditcard', 'cardnumber', 'zipcode', 'postalcode'
])

function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
	if (normalized === 'auth' || normalized.includes('auth') && !normalized.includes('author')) return true
	return SENSITIVE_NORMALIZED_KEYS.some((candidate) => normalized.includes(candidate))
}

function isPiiKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
	for (const candidate of PII_NORMALIZED_KEYS) {
		if (normalized === candidate
			|| (candidate !== 'ip' && candidate !== 'dob' && candidate !== 'address'
				&& normalized.includes(candidate))) return true
	}
	return false
}

function isIdentifierKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
	return IDENTIFIER_TAG_KEY.test(normalized)
		|| COMPOUND_IDENTIFIER_KEYS.some((candidate) => normalized.includes(candidate))
}

export function sanitizeSentryTagValue(key: string, value: string): string {
	if (value.length > MAX_STRING_LENGTH) return 'oversized'
	const trimmed = value.trim()
	if (!trimmed) return 'empty'
	const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
	if (normalizedKey === 'code') return SAFE_ERROR_CODES.has(trimmed) ? trimmed : 'custom'
	if (isIdentifierKey(normalizedKey)) {
		return normalizedKey === 'email' ? 'email' : `id:${simpleHash(trimmed)}`
	}
	if (isPiiKey(normalizedKey)) return `pii:${simpleHash(trimmed)}`
	if (normalizedKey === 'servername') return `server:${simpleHash(trimmed)}`
	if (normalizedKey === 'source') return SAFE_SOURCE_TAGS.has(trimmed)
		? trimmed : `source:${simpleHash(trimmed)}`
	if (isIpAddressLike(trimmed)) return `ip:${simpleHash(trimmed)}`
	try {
		const url = new URL(trimmed)
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return `url:${simpleHash(`${url.protocol}//${url.hostname}${url.pathname}`)}`
		}
	} catch {
		// Continue with pattern classification.
	}
	if (/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/iu.test(trimmed)) return 'email'
	if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(trimmed)) return 'id'
	if (/\b[0-9a-f]{16,}\b/iu.test(trimmed) || /\b[A-Za-z0-9+/=_-]{40,}\b/u.test(trimmed)) return 'token'
	if (/(^|[-_])(tenant|workspace|account|customer|org|project|user)([-_]|$)/iu.test(trimmed) && /[-_]/u.test(trimmed)) {
		return `id:${simpleHash(trimmed)}`
	}
	// Low-cardinality keys are not a privacy bypass. Preserve a conventional
	// environment/release only after free-form redaction confirms that it does
	// not contain a credential, URL, assignment, or other sensitive format.
	const redacted = redactErrorValue(trimmed)
	if (typeof redacted !== 'string' || redacted !== trimmed) return `value:${simpleHash(trimmed)}`
	if (LOW_CARDINALITY_TAGS.has(normalizedKey) && /^[a-z0-9_.:-]{1,64}$/iu.test(trimmed)) return trimmed
	if (/\/\d{2,}\b/u.test(trimmed) || /\b\d{4,}\b/u.test(trimmed)) return `id:${simpleHash(trimmed)}`
	if (trimmed.length > 64) return `value:${simpleHash(trimmed)}`
	return /^[a-z0-9_.:-]{1,64}$/iu.test(trimmed) ? trimmed : `value:${simpleHash(trimmed)}`
}

function sanitizeTagKey(key: string): string {
	const trimmed = key.trim()
	return /^[a-z][a-z0-9_.-]{0,63}$/iu.test(trimmed) ? trimmed : `tag_${simpleHash(trimmed)}`
}

function sanitizeExtraKey(key: string): string {
	if (/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(key)
		&& (!IDENTIFIER_EXTRA_KEY.test(key) || isIdentifierExtraKey(key))) return key
	return `field_${simpleHash(key)}`
}

function isIdentifierExtraKey(key: string): boolean {
	return isIdentifierKey(key)
}

export function sanitizeSentryString(value: string): string {
	const redacted = redactErrorValue(value)
	const safe = typeof redacted === 'string' ? redacted : '[REDACTED]'
	return safe.length > MAX_STRING_LENGTH ? `${safe.slice(0, MAX_STRING_LENGTH)}...` : safe
}

export function sanitizeSentryTags(tags: Readonly<Record<string, string>>): Record<string, string> {
	if (tags && typeof tags === 'object' && SANITIZED_SENTRY_TAGS.has(tags)) {
		return tags as Record<string, string>
	}
	let keys: readonly PropertyKey[]
	try {
		keys = Reflect.ownKeys(tags).slice(0, MAX_OBJECT_ENTRIES)
	} catch {
		return {}
	}
	const sanitized: Record<string, string> = Object.create(null) as Record<string, string>
	for (const key of keys) {
		if (typeof key !== 'string' || key.length === 0 || key.length > 128 || isSensitiveKey(key)) continue
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(tags, key) } catch { continue }
		if (!descriptor?.enumerable || !('value' in descriptor)) continue
		const value = descriptor.value as unknown
		if (typeof value !== 'string') continue
		sanitized[sanitizeTagKey(key)] = sanitizeSentryTagValue(key, value)
	}
	Object.freeze(sanitized)
	SANITIZED_SENTRY_TAGS.add(sanitized)
	return sanitized
}

interface ExtraBudget {nodes: number; chars: number}

function safeArrayKind(value: object): boolean | undefined {
	try { return Array.isArray(value) } catch { return undefined }
}

function sanitizeExtraString(value: string, budget: ExtraBudget): string {
	if (budget.chars <= 0 || value.length > budget.chars) {
		budget.chars = 0
		return '[Truncated]'
	}
	const safe = sanitizeSentryString(value).slice(0, budget.chars)
	budget.chars -= Math.max(value.length, safe.length)
	return safe
}

function sanitizeSentryExtraInternal(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
	budget: ExtraBudget
): unknown {
	if (budget.nodes <= 0) return '[Truncated]'
	budget.nodes--
	if (depth > MAX_EXTRA_DEPTH) return '[MaxDepth]'
	const arrayKind = value && typeof value === 'object' ? safeArrayKind(value) : false
	if (arrayKind === undefined) return '[Unserializable]'
	if (arrayKind) {
		const arrayValue = value as readonly unknown[]
		if (seen.has(arrayValue)) return '[Circular]'
		seen.add(arrayValue)
		let length: number
		try {
			const descriptor = Object.getOwnPropertyDescriptor(arrayValue, 'length')
			const observed = descriptor && 'value' in descriptor ? descriptor.value : undefined
			if (!Number.isSafeInteger(observed) || observed < 0) throw new Error()
			length = observed
		} catch {
			seen.delete(arrayValue)
			return '[Unserializable]'
		}
		const result: unknown[] = []
		let index = 0
		for (; index < Math.min(length, MAX_OBJECT_ENTRIES) && budget.nodes > 0; index += 1) {
			let descriptor: PropertyDescriptor | undefined
			try { descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index)) } catch { descriptor = undefined }
			result.push(descriptor && 'value' in descriptor
				? sanitizeSentryExtraInternal(descriptor.value, seen, depth + 1, budget)
				: null)
		}
		if (index < Math.min(length, MAX_OBJECT_ENTRIES) || length > MAX_OBJECT_ENTRIES) result.push('[Truncated]')
		seen.delete(arrayValue)
		return result
	}
	if (value && typeof value === 'object') {
		if (seen.has(value)) return '[Circular]'
		seen.add(value)
		let keys: readonly PropertyKey[]
		let truncated = false
		try {
			const observedKeys = Reflect.ownKeys(value)
			truncated = observedKeys.length > MAX_OBJECT_ENTRIES
			keys = observedKeys.slice(0, MAX_OBJECT_ENTRIES)
		} catch {
			seen.delete(value)
			return '[Unserializable]'
		}
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const key of keys) {
			if (budget.nodes <= 0) { truncated = true; break }
			if (typeof key !== 'string' || key.length === 0 || key.length > 128 || FORBIDDEN_OBJECT_KEYS.has(key)) continue
			let descriptor: PropertyDescriptor | undefined
			try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { continue }
			if (!descriptor?.enumerable || !('value' in descriptor)) continue
			const outputKey = sanitizeExtraKey(key)
			if (outputKey.length > budget.chars) {
				budget.chars = 0
				truncated = true
				break
			}
			budget.chars -= outputKey.length
			result[outputKey] = isSensitiveKey(key)
				? '[REDACTED]'
				: isPiiKey(key)
					? '[DROPPED]'
					: isIdentifierExtraKey(key)
						? typeof descriptor.value === 'string' ? `id:${simpleHash(descriptor.value)}` : '[REDACTED]'
						: sanitizeSentryExtraInternal(descriptor.value, seen, depth + 1, budget)
		}
		if (truncated) result.__truncated = true
		seen.delete(value)
		return result
	}
	if (typeof value === 'string') return sanitizeExtraString(value, budget)
	const redacted = redactErrorValue(value)
	return typeof redacted === 'string' ? sanitizeExtraString(redacted, budget) : redacted
}

export function sanitizeSentryExtra(value: unknown): unknown {
	try {
		return sanitizeSentryExtraInternal(value, new WeakSet(), 0, {
			nodes: MAX_EXTRA_NODES,
			chars: MAX_EXTRA_CHARACTERS
		})
	} catch {
		return '[Unserializable]'
	}
}

export function sentryStackFrames(stack?: string): Array<Record<string, unknown>> | undefined {
	if (!stack) return undefined
	const frames = stack.split('\n').slice(1, 101).map((line) => line.trim()).filter(Boolean)
		.map((line) => ({filename: sanitizeSentryString(line)}))
	return frames.length > 0 ? frames.reverse() : undefined
}
