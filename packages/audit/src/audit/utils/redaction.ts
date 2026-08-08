import {createHash} from 'node:crypto'

import type {JsonValue} from '@ooopsstudio/core/contracts/json'

import {AUDIT_MAXIMUM_LIMITS} from '../constants'
import type {AuditRedactionRule, AuditSafetyLimits} from '../types/store'

import {isAuditSafeString} from './string-safety'

// Credential fields are frequently qualified with storage or transport suffixes
// (for example passwordHash, accessTokenValue, or clientSecretEncrypted). Treat
// the credential marker as sensitive wherever it appears in the normalized key;
// otherwise those common variants bypass mandatory redaction and become
// immutable audit evidence.
const SENSITIVE_KEY = /password|passwd|passphrase|passcode|pwd|secret|token|apikey|privatekey|accesskey|accountkey|encryptionkey|masterkey|signingkey|credential|authorization|cookie|sessionid|cardnumber|creditcard|userid|idempotencykey|email|phone|ssn|cvv|recoverycode|backupcode|verificationcode|mfacode|seedphrase|mnemonic|otp|^(?:session|card|auth|pin|dsn|sig|signature|key)$/

const STANDALONE_CREDENTIAL = /\b(?:A(?:KI|SI)A[A-Z0-9]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|(?:sk-(?:proj-|ant-)?|glpat-|dop_v1_)[A-Za-z0-9_-]{20,}|SK[\da-fA-F]{32}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{35}|npm_[A-Za-z0-9]{20,})\b/gu

function normalizedKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function defaultSensitiveKey(key: string): boolean {
	if (/[^\p{ASCII}]/u.test(key)) return true
	return SENSITIVE_KEY.test(normalizedKey(key))
}

function freeFormPath(path: string): boolean {
	const normalized = path.toLowerCase()
	return normalized === '' || normalized === 'summary' || normalized.endsWith('.summary') || normalized === 'message'
		|| normalized.endsWith('.message') || normalized === 'description' || normalized.endsWith('.description')
		|| normalized === 'details' || normalized.endsWith('.details') || normalized === 'stack'
		|| normalized.endsWith('.stack') || normalized.startsWith('context') || normalized.includes('.context.')
		|| normalized.startsWith('metadata') || normalized.includes('.metadata.') || normalized.startsWith('changeset')
		|| normalized.startsWith('attributes') || normalized.includes('.attributes.')
		|| normalized.endsWith('.displayname') || normalized.endsWith('.resource')
}

function redactSensitiveAssignments(value: string): string {
	let output = ''
	let cursor = 0
	let enclosingQuote: '"' | "'" | undefined
	let escaped = false
	for (let separator = 0; separator < value.length; separator += 1) {
		const current = value[separator]!
		if (escaped) { escaped = false; continue }
		if (enclosingQuote && current === '\\') { escaped = true; continue }
		if (current === '"' || current === "'") {
			enclosingQuote = enclosingQuote === current ? undefined : enclosingQuote ?? current
			continue
		}
		if (value[separator] !== ':' && value[separator] !== '=') continue
		let keyEnd = separator
		while (keyEnd > cursor && /\s/u.test(value[keyEnd - 1]!)) keyEnd -= 1
		let keyStart = keyEnd
		while (keyStart > cursor && !/[\s:=,;]/u.test(value[keyStart - 1]!)) keyStart -= 1
		const key = value.slice(keyStart, keyEnd)
		if (!key || !defaultSensitiveKey(key)) continue
		let valueStart = separator + 1
		while (valueStart < value.length && /\s/u.test(value[valueStart]!)) valueStart += 1
		let valueEnd = valueStart
		const quote = value[valueStart]
		if (quote === '"' || quote === "'") {
			let valueEscaped = false
			for (valueEnd += 1; valueEnd < value.length; valueEnd += 1) {
				const character = value[valueEnd]!
				if (valueEscaped) valueEscaped = false
				else if (character === '\\') valueEscaped = true
				else if (character === quote) { valueEnd += 1; break }
			}
		} else if (enclosingQuote) {
			let valueEscaped = false
			while (valueEnd < value.length) {
				const character = value[valueEnd]!
				if (valueEscaped) valueEscaped = false
				else if (character === '\\') valueEscaped = true
				else if (character === enclosingQuote) break
				valueEnd += 1
			}
		} else while (valueEnd < value.length && !/[\s,;]/u.test(value[valueEnd]!)) valueEnd += 1
		if (valueEnd === valueStart) continue
		output += `${value.slice(cursor, keyStart)}${key}=[REDACTED]`
		cursor = valueEnd
		separator = valueEnd - 1
	}
	return output + value.slice(cursor)
}

function sensitiveString(value: string, path: string): string {
	if (!freeFormPath(path)) return value
	const protectedValue = redactSensitiveAssignments(value
		.replace(STANDALONE_CREDENTIAL, '[REDACTED_TOKEN]')
		.replace(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
		.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"',;]+/g, (candidate) => {
			try {
				const url = new URL(candidate)
				url.username = ''
				url.password = ''
				url.search = ''
				url.hash = ''
				return url.toString()
			} catch { return '[REDACTED_URL]' }
		})
		.replace(/\b((?:Bearer|Basic)\s+)[^\s,;]+/gi, '$1[REDACTED]'))
		.replace(/\b(authorization|auth|cookie|credential|password|passwd|passphrase|pin|otp|recovery[_ -]?code|secret|client[_ -]?secret|token|api[_ -]?key|private[_ -]?key|session(?:[_ -]?id)?)\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*(?:"|$)|'(?:\\.|[^'\\\r\n])*(?:'|$)|[^\s,;]+)/gi, '$1=[REDACTED]')
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
		.replace(/[^\s@"'<>]+@[^\s@"'<>]+/gu, '[REDACTED_EMAIL]')
		.replace(/\+\d(?:[\s().-]*\d){6,14}\b/g, '[REDACTED_PHONE]')
		.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
		.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]')
	return protectedValue
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[REDACTED_UUID]')
		.replace(/\b[0-9a-f]{32,}\b/gi, '[REDACTED_TOKEN]')
		.replace(/\b(?=[a-z0-9_-]{32,}\b)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
		.replace(/\b(?=[A-Za-z0-9+/_=-]{32,}\b)(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]+/g, '[REDACTED_TOKEN]')
}

function boundedString(value: string, limits: AuditSafetyLimits): string {
	return value.length <= limits.maxStringLength ? value : value.slice(0, limits.maxStringLength)
}

function initialPathSegments(path: string): Array<string | number> {
	return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment)
}

function matchingRule(
	pathSegments: ReadonlyArray<string | number>,
	key: string,
	rules: ReadonlyArray<AuditRedactionRule>
): AuditRedactionRule | undefined {
	return rules.find((rule) => {
		if ('path' in rule) return rule.path.length === pathSegments.length
			&& rule.path.every((segment, index) => segment === pathSegments[index])
		if (typeof rule.key === 'string') return normalizedKey(rule.key) === normalizedKey(key)
		rule.key.lastIndex = 0
		const matches = rule.key.test(key)
		rule.key.lastIndex = 0
		return matches
	})
}

function hashed(value: unknown, limits: AuditSafetyLimits): string {
	const serialized = JSON.stringify(snapshotAuditValue(value, '__hash__', limits)) ?? '[UNAVAILABLE]'
	return boundedString(`[HASH:${createHash('sha256').update(serialized).digest('hex').slice(0, 16)}]`, limits)
}

function isAuditRedactionMarker(value: unknown): value is string {
	return value === '[REDACTED]' || (typeof value === 'string' && /^\[HASH:[a-f0-9]{16}\]$/.test(value))
}

function transformAuditValue(
	value: unknown,
	rules: ReadonlyArray<AuditRedactionRule>,
	path: string,
	limits: AuditSafetyLimits,
	redact: boolean
): JsonValue {
	const seen = new WeakSet<object>()
	let consumedBytes = 0
	const consume = (bytes: number, currentPath: string) => {
		consumedBytes += bytes
		if (consumedBytes > limits.maxRecordBytes) {
			throw new Error(`Audit value at ${currentPath || '<root>'} exceeds maximum byte budget.`)
		}
	}
	const visit = (current: unknown, currentPath: string, pathSegments: ReadonlyArray<string | number>, depth: number): JsonValue => {
		if (depth > limits.maxDepth) {
			throw new Error(`Audit value at ${currentPath || '<root>'} is unsafe or non-serializable because it exceeds maximum depth ${limits.maxDepth}.`)
		}
		if (current === null || typeof current === 'boolean') {
			consume(current === null ? 4 : current ? 4 : 5, currentPath)
			return current
		}
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) throw new Error(`Audit value at ${currentPath || '<root>'} is not finite.`)
			consume(String(current).length, currentPath)
			return current
		}
		if (typeof current === 'string') {
			if (current.length > limits.maxStringLength) throw new Error(`Audit string at ${currentPath || '<root>'} is too long.`)
			if (!isAuditSafeString(current)) throw new Error(`Audit string at ${currentPath || '<root>'} contains unsupported characters.`)
			consume(Buffer.byteLength(JSON.stringify(current)), currentPath)
			return boundedString(redact ? sensitiveString(current, currentPath) : current, limits)
		}
		if (typeof current !== 'object') throw new Error(`Audit value at ${currentPath || '<root>'} is not JSON-compatible.`)
		if (seen.has(current)) throw new Error(`Audit value at ${currentPath || '<root>'} is circular.`)
		seen.add(current)
		try {
			if (Array.isArray(current)) {
				consume(2, currentPath)
				let values: unknown[]
				try {
					const length = Object.getOwnPropertyDescriptor(current, 'length')?.value
					if (!Number.isSafeInteger(length) || length < 0) throw new Error()
					if (length > limits.maxArrayEntries) throw new RangeError()
					const allowedKeys = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
					if (Reflect.ownKeys(current).some((key) => typeof key !== 'string' || !allowedKeys.has(key))) throw new Error()
					values = Array.from({length}, (_, index) => {
						const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
						if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
						return descriptor.value
					})
				} catch(error) {
					if (error instanceof RangeError) {
						throw new Error(`Audit array at ${currentPath || '<root>'} exceeds the maximum of ${limits.maxArrayEntries} entries.`)
					}
					throw new Error(`Audit array at ${currentPath || '<root>'} contains invalid fields.`)
				}
				const result: JsonValue[] = []
				for (let index = 0; index < values.length; index++) {
					if (index > 0) consume(1, currentPath)
					result.push(visit(values[index], `${currentPath}[${index}]`, [...pathSegments, index], depth + 1))
				}
				return result
			}
			consume(2, currentPath)
			let entries: Array<[string, unknown]>
			try {
				const prototype = Object.getPrototypeOf(current)
				if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain object')
				entries = []
				for (const key of Reflect.ownKeys(current)) {
					if (typeof key !== 'string') throw new Error('symbol key')
					const descriptor = Object.getOwnPropertyDescriptor(current, key)
					if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('invalid descriptor')
					entries.push([key, descriptor.value])
				}
			} catch {
				throw new Error(`Audit value at ${currentPath || '<root>'} is not a readable plain object.`)
			}
			if (entries.length > limits.maxObjectKeys) throw new Error(`Audit object at ${currentPath || '<root>'} has too many keys.`)
			const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
			const originalKeys = new Set(entries.map(([key]) => key))
			let retainedEntries = 0
			for (const [key, raw] of entries) {
				if (!key || key.length > 256 || !isAuditSafeString(key)) throw new Error(`Audit object key at ${currentPath || '<root>'} is invalid.`)
				const nextPath = currentPath ? `${currentPath}.${key}` : key
				const nextPathSegments = [...pathSegments, key]
				const rule = redact ? matchingRule(nextPathSegments, key, rules) : undefined
				if (rule?.action === 'drop') continue
				let outputKey = key
				const keyContainsSensitivePayload = redact && sensitiveString(key, 'metadata') !== key
				if (redact && (keyContainsSensitivePayload || (defaultSensitiveKey(key) && /[\s=:/.]/u.test(key)))) {
					let redactedKeyIndex = retainedEntries
					do { outputKey = `__redacted_key_${redactedKeyIndex++}__` }
					while (Object.hasOwn(output, outputKey) || originalKeys.has(outputKey))
				}
				consume(Buffer.byteLength(JSON.stringify(outputKey)) + 1 + (retainedEntries > 0 ? 1 : 0), nextPath)
				retainedEntries += 1
				if (rule?.action === 'mask') output[outputKey] = visit('[REDACTED]', nextPath, nextPathSegments, depth + 1)
				else if (rule?.action === 'hash') output[outputKey] = visit(isAuditRedactionMarker(raw) ? raw : hashed(raw, limits), nextPath, nextPathSegments, depth + 1)
				else if (redact && defaultSensitiveKey(key)) output[outputKey] = visit(isAuditRedactionMarker(raw) ? raw : '[REDACTED]', nextPath, nextPathSegments, depth + 1)
				else output[outputKey] = visit(raw, nextPath, nextPathSegments, depth + 1)
			}
			return output
		} finally {
			seen.delete(current)
		}
	}
	return visit(value, path, initialPathSegments(path), 0)
}

export function sanitizeAuditValue(
	value: unknown,
	rules: ReadonlyArray<AuditRedactionRule> = [],
	path = '',
	limits: AuditSafetyLimits = AUDIT_MAXIMUM_LIMITS
): JsonValue {
	return transformAuditValue(value, rules, path, limits, true)
}

/** Bounded exact snapshot used to prove a store response was already redacted. */
export function snapshotAuditValue(
	value: unknown,
	path = '',
	limits: AuditSafetyLimits = AUDIT_MAXIMUM_LIMITS
): JsonValue {
	return transformAuditValue(value, [], path, limits, false)
}

export function sanitizeAuditDiagnosticMessage(error: unknown): string {
	let raw: string | undefined
	if (typeof error === 'string') raw = error
	else if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') raw = String(error)
	else if (error && typeof error === 'object') {
		let current: object | null = error
		try {
			for (let depth = 0; current && depth < 16; depth += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
				if (descriptor) {
					if (!('value' in descriptor) || typeof descriptor.value !== 'string') break
					raw = descriptor.value
					break
				}
				current = Object.getPrototypeOf(current) as object | null
			}
		} catch { /* use the fixed fallback */ }
	}
	try {
		const sanitized = sanitizeAuditValue((raw ?? 'Audit operation failed.').slice(0, AUDIT_MAXIMUM_LIMITS.maxStringLength))
		return typeof sanitized === 'string' && sanitized ? sanitized : 'Audit operation failed.'
	} catch { return 'Audit operation failed.' }
}
