import {
	CREDENTIAL_URI_PATTERN,
	PRIVATE_KEY_HEADER_PATTERN,
	STANDALONE_CREDENTIAL_PATTERN
} from '../core/redacting-utilities'
import type {RedactingPolicy} from '../types/redacting'

export const SAFE_DEFAULT_REDACT_KEYS: ReadonlyArray<string | RegExp> = [
	'authorization',
	'auth',
	'credential',
	'credentials',
	'cookie',
	'set-cookie',
	'password',
	'passwd',
	'secret',
	'token',
	'api-key',
	'access-token',
	'refresh-token',
	'private-key',
	'session-id',
	'user-id',
	'account-id',
	'customer-id',
	'tenant-id',
	'workspace-id',
	'organization-id',
	'project-id',
	'email',
	'phone',
	'ssn',
	'credit-card',
	'card-number',
	'cvv',
	'ip',
	'ip-address',
	'x-forwarded-for',
	// Catch conventional prefixes/casing without treating unrelated fields such
	// as `tokenCount` as credentials. `matchesRedactKey` also tests this pattern
	// against the punctuation-free normalized key.
	/^[a-z0-9]*(?:password|passwd|secret|authorization|cookie|apikey|privatekey|token|sessionid|userid|accountid|customerid|tenantid|workspaceid|organizationid|projectid|email|phone|ssn|creditcard|cardnumber|cvv|ipaddress)$/iu,
	/auth(?!or)|credential/iu
]

export const SAFE_DEFAULT_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
	STANDALONE_CREDENTIAL_PATTERN,
	CREDENTIAL_URI_PATTERN,
	PRIVATE_KEY_HEADER_PATTERN,
	/\bbearer\s+[a-z0-9._~+/-]+=*/iu,
	/\bbasic\s+[a-z0-9+/]+=*/iu,
	/\b([a-z0-9_-]*(?:api[-_ ]?key|auth(?:orization)?|cookie|set[-_ ]?cookie|token|secret|password|passwd|private[-_ ]?key|session(?:[-_ ]?id)?|phone|credit[-_ ]?card|card[-_ ]?number|cvv|access[-_ ]?token|refresh[-_ ]?token))\s*[:=]\s*["']?([^&\s"'<>},;]+)/iu,
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
	/\b\d{3}-\d{2}-\d{4}\b/u,
	/\b(?:\d[ -]*?){13,19}\b/u,
	/\bcvv[=: ]+\d{3,4}\b/iu,
	/\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
	/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/iu
]

export const SAFE_DEFAULT_REDACTING_POLICY: RedactingPolicy = {
	redactKeys: SAFE_DEFAULT_REDACT_KEYS,
	redactValuePatterns: SAFE_DEFAULT_VALUE_PATTERNS
}

const append = <T>(...values: ReadonlyArray<ReadonlyArray<T> | undefined>): T[] | undefined => {
	const merged = values.flatMap((value) => value ?? [])
	return merged.length > 0 ? merged : undefined
}

export function mergeRedactingPolicies(
	...policies: ReadonlyArray<Readonly<RedactingPolicy> | undefined>
): RedactingPolicy {
	const rules = append(...policies.map((policy) => policy?.rules))
	const redactKeys = append(...policies.map((policy) => policy?.redactKeys))
	const redactValuePatterns = append(...policies.map((policy) => policy?.redactValuePatterns))

	return {
		...(rules ? {rules} : {}),
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		...(redactKeys ? {redactKeys} : {}),
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		...(redactValuePatterns ? {redactValuePatterns} : {})
	}
}
