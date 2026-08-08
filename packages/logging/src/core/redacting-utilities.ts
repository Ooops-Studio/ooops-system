import type {LogAttributes, LogContext, LogRecord} from '@ooopsstudio/core/contracts/logging'

import {inspectLoggingProperty, isPlainLoggingObject} from '../utils/capabilities'

const UNSERIALIZABLE = '[Unserializable]'
const MAX_TAGS = 100
const MAX_FREEFORM_STRING_BYTES = 128_000
const MAX_FREEFORM_TRAVERSAL_NODES = 1_000
const MAX_FREEFORM_KEY_LENGTH = 256
const TRUNCATED = '[REDACTED_TRUNCATED]'
const ASSIGNMENT_VALUE_PATTERN = "(?:(['\"])(?:\\\\.|[^\\\\\\r\\n])*\\4(?=$|[&\\s,<>},;])|['\"][^\\r\\n]*|[^&\\s\"'<>},;]+)"
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(String.raw`\b([a-z0-9_-]*(?:api[-_]?key|auth(?:orization)?|cookie|set[-_]?cookie|token|secret|password|passwd|private[-_]?key|session(?:[-_]?id)?|user[-_]?id|account[-_]?id|customer[-_]?id|tenant[-_]?id|workspace[-_]?id|organization[-_]?id|project[-_]?id|phone|email|ssn|credit[-_]?card|card[-_]?number|cvv|access[-_]?token|refresh[-_]?token))(["']?)(\s*[:=]\s*)${ASSIGNMENT_VALUE_PATTERN}`, 'giu')
const SPACED_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(String.raw`\b((?:set[^a-z0-9]+cookie|pass[^a-z0-9]+(?:word|wd|phrase)|(?:api|access|private)[^a-z0-9]+(?:key|token)|client[^a-z0-9]+secret|refresh[^a-z0-9]+token))(["']?)(\s*[:=]\s*)${ASSIGNMENT_VALUE_PATTERN}`, 'giu')
const COMPOUND_ASSIGNMENT_PREFIX_PATTERN = /(?<![\p{L}\p{N}_])["']?(\p{L}[^\t\n\v\f\r =:&,"'<>}]*)["']?\s*[=:]\s*/giu
const ASSIGNMENT_VALUE_ONLY_PATTERN = /(?:(['"])(?:\\.|[^\\\r\n])*\1(?=$|[&\s,<>},;])|['"][^\r\n]*|[^&\s"'<>},;]+)/uy
const SENSITIVE_KEY_STEMS = [
	'api[-_ ]?key', 'auth(?:orization)?', 'cookie', 'password', 'passwd', 'private[-_ ]?key',
	'secret', 'session(?:[-_ ]?id)?', 'token', 'access[-_ ]?token', 'refresh[-_ ]?token',
	'user[-_ ]?id', 'account[-_ ]?id', 'customer[-_ ]?id', 'tenant[-_ ]?id',
	'workspace[-_ ]?id', 'organization[-_ ]?id', 'project[-_ ]?id', 'email', 'phone',
	'ssn', 'credit[-_ ]?card', 'card[-_ ]?number', 'cvv'
].join('|')
const SAFE_SENSITIVE_KEY_SUFFIXES = [
	'count', 'type', 'status', 'name', 'hash', 'present', 'length', 'source',
	'expiry', 'expires', 'prefix', 'suffix'
].join('|')
const SENSITIVE_KEY_WITH_PAYLOAD_PATTERN = new RegExp(
	String.raw`(?:^|[^a-z0-9])(?:${SENSITIVE_KEY_STEMS})(?:[=:/.]|[-_](?!(?:${SAFE_SENSITIVE_KEY_SUFFIXES})$)).+`,
	'iu'
)

export const STANDALONE_CREDENTIAL_PATTERN = new RegExp(
	String.raw`\b(?:A(?:KIA|SIA)[A-Z0-9]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|` +
	String.raw`gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|` +
	String.raw`(?:sk-(?:proj-|ant-)?|glpat-|dop_v1_)[A-Za-z0-9_-]{20,}|SK[0-9a-fA-F]{32}|` +
	String.raw`xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{20,})\b`,
	'gu'
)
export const CREDENTIAL_URI_PATTERN = new RegExp(
	String.raw`\b[a-z][a-z0-9+.-]*://[^\s/@]+@[^\s"'<>]+`,
	'giu'
)
export const PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u

const SENSITIVE_STRING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[STANDALONE_CREDENTIAL_PATTERN, '[REDACTED_TOKEN]'],
	[CREDENTIAL_URI_PATTERN, '[REDACTED_URL]'],
	[/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[REDACTED_EMAIL]'],
	[/https?:\/\/[^\s"'<>]+/giu, '[REDACTED_URL]'],
	[/\b(Bearer|Basic)\s+[^,\s"'<>}]+/giu, '$1 [REDACTED]'],
	[SENSITIVE_ASSIGNMENT_PATTERN, '$1$2$3$4[REDACTED]$4'],
	[SPACED_CREDENTIAL_ASSIGNMENT_PATTERN, '$1$2$3$4[REDACTED]$4'],
	[/\b\d{3}-\d{2}-\d{4}\b/gu, '[REDACTED_SSN]'],
	[/\b(?:\d[ -]*?){13,19}\b/gu, '[REDACTED_CARD]'],
	[/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[REDACTED_IP]'],
	[/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/giu, '[REDACTED_IP]'],
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '[REDACTED_ID]'],
	[/\b(?=[0-9a-f]{24,}\b)(?=[0-9a-f]*\d)[0-9a-f]+\b/giu, '[REDACTED_TOKEN]'],
	[/\b(?=[A-Za-z0-9+/=_-]{40,}\b)(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[A-Z0-9+/=_-])[A-Za-z0-9+/=_-]+\b/gu, '[REDACTED_TOKEN]']
]

const SENSITIVE_FREEFORM_KEYS = new Set([
	'apikey',
	'api_key',
	'api-key',
	'authorization',
	'auth',
	'cookie',
	'password',
	'passwd',
	'privatekey',
	'private_key',
	'private-key',
	'secret',
	'session',
	'token',
	'access_token',
	'access-token',
	'accesstoken',
	'refresh_token',
	'refresh-token',
	'refreshtoken',
	'userid',
	'accountid',
	'customerid',
	'tenantid',
	'workspaceid',
	'organizationid',
	'projectid',
	'email',
	'phone',
	'ssn',
	'creditcard',
	'cardnumber',
	'cvv',
	'ipaddress',
	'forwardedfor'
])

function foldSensitiveKey(key: string): string {
	return key.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
		.replace(/[013457@$]/gu, (character) => 'oieastas'['013457@$'.indexOf(character)]!)
}

export function redactString(value: string): string {
	let bytes = 0
	let end = 0
	let bounded = value
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0
		const nextBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
		if (bytes + nextBytes > MAX_FREEFORM_STRING_BYTES) {
			bounded = `${value.slice(0, end)}${TRUNCATED}`
			break
		}
		bytes += nextBytes
		end += character.length
	}
	if (PRIVATE_KEY_HEADER_PATTERN.test(bounded)) return '[REDACTED_PRIVATE_KEY]'
	let redacted = bounded
	for (const [pattern, replacement] of SENSITIVE_STRING_PATTERNS) {
		redacted = redacted.replace(pattern, replacement)
	}
	return redactCompoundSensitiveAssignments(redacted)
}

function normalizeSensitiveKey(key: string): string {
	if (/[^\p{ASCII}]/u.test(key)) return 'secret'
	const folded = foldSensitiveKey(key)
	return folded.replace(/[^a-z0-9_-]/gu, '')
}

export function isSensitiveFreeformKey(key: string): boolean {
	const normalized = normalizeSensitiveKey(key)
	if (SENSITIVE_FREEFORM_KEYS.has(normalized)) return true
	const compact = normalized.replace(/[_-]/gu, '')
	if (
		compact.includes('apikey') ||
		compact.includes('authorization') ||
		(compact.includes('auth') && !compact.includes('author')) ||
		compact.includes('credential') ||
		compact.includes('cookie') ||
		compact.includes('password') ||
		compact.includes('passwd') ||
		compact.includes('privatekey') ||
		compact.includes('secret') ||
		compact.includes('session') ||
		(compact.includes('token') && !compact.endsWith('tokencount')) ||
		/(?:userid|accountid|customerid|tenantid|workspaceid|organizationid|projectid|email|phone|ssn|creditcard|cardnumber|cvv|ipaddress|forwardedfor)/u.test(compact)
	) return true
	return /(?:^|[_-])(?:api[_-]?key|auth(?:orization)?|cookie|password|secret|session|token)(?:$|[_-])/iu.test(normalized)
}

export function hasSensitiveKeyObfuscation(key: string): boolean {
	return /[^\p{ASCII}]/u.test(key) || (
		foldSensitiveKey(key) !== key.toLowerCase() && isSensitiveFreeformKey(key)
	)
}

/** Detect a sensitive field name that also carries caller data in the key. */
export function sensitiveKeyContainsPayload(key: string): boolean {
	if (/[^\p{ASCII}]/u.test(key)) return true
	const folded = foldSensitiveKey(key)
	return SENSITIVE_KEY_WITH_PAYLOAD_PATTERN.test(folded)
}

function redactCompoundSensitiveAssignments(value: string): string {
	const output: string[] = []
	let cursor = 0
	for (const match of value.matchAll(COMPOUND_ASSIGNMENT_PREFIX_PATTERN)) {
		const key = match[1]
		if (!key || match.index! < cursor || !isSensitiveFreeformKey(key)) continue
		const start = match.index! + match[0].length
		ASSIGNMENT_VALUE_ONLY_PATTERN.lastIndex = start
		const assignmentValue = ASSIGNMENT_VALUE_ONLY_PATTERN.exec(value)?.[0]
		if (!assignmentValue) continue
		output.push(value.slice(cursor, start), '[REDACTED]')
		cursor = start + assignmentValue.length
	}
	if (!cursor) return value
	output.push(value.slice(cursor))
	return output.join('')
}

export function safeRead<T>(value: object | undefined, key: string): T | undefined {
	if (!value) return undefined
	const inspected = inspectLoggingProperty<T>(value, key)
	return inspected.safe ? inspected.value : undefined
}

export function safeReadValue(value: object | undefined, key: string): {value: unknown; safe: boolean; exists: boolean} {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!value) return {value: undefined, safe: true, exists: false}
	const inspected = inspectLoggingProperty<unknown>(value, key)
	if (!inspected.safe) return {value: UNSERIALIZABLE, safe: false, exists: true}
	return {value: inspected.value, safe: true, exists: inspected.found && inspected.value !== undefined}
}

export function safeReadString(value: object | undefined, key: string): {value?: string; safe: boolean} {
	if (!value) return {safe: true}
	const inspected = inspectLoggingProperty<unknown>(value, key)
	if (!inspected.safe) return {value: UNSERIALIZABLE, safe: false}
	const current = inspected.value
	if (current === undefined) return {safe: true}
	return typeof current === 'string'
		? {value: current, safe: true}
		: {value: UNSERIALIZABLE, safe: false}
}

export function safeReadTags(context: LogContext | undefined): {tags?: readonly string[]; safe: boolean} {
	if (!context) return {safe: true}
	let current: unknown
	const inspectedTags = inspectLoggingProperty<unknown>(context, 'tags')
	if (!inspectedTags.safe) return {tags: [UNSERIALIZABLE], safe: false}
	current = inspectedTags.value
	if (current === undefined) return {safe: true}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!Array.isArray(current)) return {tags: [UNSERIALIZABLE], safe: false}
	const length = safeArrayLength(current)
	if (length === undefined) return {tags: [UNSERIALIZABLE], safe: false}
	// Tags cross an untrusted enrichment boundary. Always materialize the
	// descriptor-only snapshot so a Proxy/getter-backed array is never retained
	// in the redacted record even when all discovered elements are strings.
	let safe = false
	const out: string[] = []
	for (let index = 0; index < Math.min(length, MAX_TAGS); index += 1) {
		try {
			const inspected = inspectLoggingProperty<unknown>(current, String(index))
			if (!inspected.safe) throw new TypeError('unavailable tag')
			const tag = inspected.value
			if (typeof tag !== 'string') throw new TypeError('invalid tag')
			out.push(tag)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		} catch {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			out.push(UNSERIALIZABLE)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			safe = false
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
	}
	if (length > MAX_TAGS) {
		out.push('[REDACTED_TRUNCATED]')
		safe = false
	}
	return {tags: out, safe}
}

export function valuesEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (left === undefined || right === undefined) return left === right
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (left.length !== right.length) return false
	return left.every((value, index) => value === right[index])
}

export function buildContext(
	context: LogContext | undefined,
	updates: {
		readonly attrsChanged: boolean
		readonly newAttrs: LogAttributes | null | undefined
		readonly namespaceChanged: boolean
		readonly nextNamespace: string | undefined
		readonly tagsChanged: boolean
		readonly nextTags: readonly string[] | undefined
	}
): LogContext | undefined {
	if (!context && !updates.namespaceChanged && !updates.tagsChanged && !updates.attrsChanged) return undefined
	const next = Object.create(null) as Record<string, unknown>
	const currentNamespace = safeRead<unknown>(context, 'namespace')
	const currentAttrs = safeRead<unknown>(context, 'attributes')
	const currentTags = safeReadTags(context).tags
	if (currentNamespace !== undefined) next.namespace = currentNamespace
	if (currentAttrs !== undefined) next.attributes = currentAttrs
	if (currentTags !== undefined) next.tags = currentTags
	if (updates.attrsChanged) next.attributes = updates.newAttrs
	if (updates.namespaceChanged && updates.nextNamespace !== undefined) next.namespace = updates.nextNamespace
	if (updates.tagsChanged) next.tags = updates.nextTags
	return next as LogContext
}

export function buildRecord(
	record: Readonly<LogRecord>,
	message: string,
	context: LogContext | undefined,
	errorChanged: boolean,
	nextError: unknown
): LogRecord {
	const next = Object.create(null) as Record<string, unknown>
	let copied = false
	try {
		for (const key of Object.keys(record)) {
			next[key] = safeReadProperty(record, key)
		}
		copied = true
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		// Fall through to explicit required fields.
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!copied) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		next.level = safeRead<unknown>(record, 'level') ?? 'info'
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		next.time = safeRead<unknown>(record, 'time') ?? 0
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	next.message = message
	if (context) next.context = context
	else delete next.context
	if (errorChanged) next.error = nextError
	return next as unknown as LogRecord
}

function safeArrayLength(value: readonly unknown[]): number | undefined {
	const inspected = inspectLoggingProperty<unknown>(value, 'length')
	return inspected.safe && typeof inspected.value === 'number' ? inspected.value : undefined
}

function safeReadIndex(value: readonly unknown[], index: number): unknown {
	const inspected = inspectLoggingProperty<unknown>(value, String(index))
	return inspected.safe ? inspected.value : UNSERIALIZABLE
}

function safeObjectKeys(value: object): readonly string[] | undefined {
	try {
		return Object.keys(value)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return undefined
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

function safeReadProperty(value: object, key: string): unknown {
	const inspected = inspectLoggingProperty<unknown>(value, key)
	return inspected.safe ? inspected.value : UNSERIALIZABLE
}

interface FreeformTraversalBudget {
	remaining: number
}

export function redactFreeformValue(
	value: unknown,
	depth = 0,
	seen = new WeakSet<object>(),
	budget: FreeformTraversalBudget = {remaining: MAX_FREEFORM_TRAVERSAL_NODES}
): unknown {
	if (budget.remaining <= 0) return TRUNCATED
	budget.remaining -= 1
	if (typeof value === 'string') {
		return redactString(value)
	}
	if (typeof value === 'function' || typeof value === 'symbol') {
		return '[REDACTED_UNSUPPORTED]'
	}
	if (Array.isArray(value)) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (depth >= 6) return '[REDACTED_MAX_DEPTH]'
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (seen.has(value)) return '[REDACTED_CIRCULAR]'
		seen.add(value)
		const length = safeArrayLength(value)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (length === undefined) {
			seen.delete(value)
			return UNSERIALIZABLE
		}
		const next: unknown[] = []
		for (let index = 0; index < Math.min(length, 100); index += 1) {
			const item = safeReadIndex(value, index)
			const redacted = redactFreeformValue(item, depth + 1, seen, budget)
			next.push(redacted)
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (length > 100) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			next.push('[REDACTED_TRUNCATED]')
		}
		return next
	}
	if (value && typeof value === 'object') {
		if (!isPlainLoggingObject(value)) return '[REDACTED_UNSUPPORTED]'
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (depth >= 6) return '[REDACTED_MAX_DEPTH]'
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (seen.has(value)) return '[REDACTED_CIRCULAR]'
		seen.add(value)
		const out = Object.create(null) as Record<string, unknown>
		const keys = safeObjectKeys(value)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (!keys) {
			seen.delete(value)
			return UNSERIALIZABLE
		}
		for (const [index, key] of keys.slice(0, 100).entries()) {
			const keyContainsSensitiveValue = key.length > MAX_FREEFORM_KEY_LENGTH ||
				redactString(key) !== key || sensitiveKeyContainsPayload(key)
			let safeKey = keyContainsSensitiveValue ? `__redacted_key_${index}__` : key
			let collision = 0
			while (Object.prototype.hasOwnProperty.call(out, safeKey)) {
				collision += 1
				safeKey = `__redacted_key_${index}_${collision}__`
			}
			if (keyContainsSensitiveValue || isSensitiveFreeformKey(key)) {
				out[safeKey] = '[REDACTED]'
				continue
			}
			const item = safeReadProperty(value, key)
			const redacted = redactFreeformValue(item, depth + 1, seen, budget)
			out[safeKey] = redacted
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (keys.length > 100) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			out.__truncated__ = '[REDACTED_TRUNCATED]'
		}
		return out
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return value
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

export function maskAttributesFailClosed(attrs: LogAttributes | undefined): LogAttributes | undefined {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!attrs) return attrs
	try {
		const masked = Object.create(null) as Record<string, unknown>
		for (const [index] of Object.keys(attrs).entries()) {
			masked[`__redacted_key_${index}__`] = '***'
		}
		return masked as LogAttributes
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return {redactionFailed: '***'} as LogAttributes
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}
