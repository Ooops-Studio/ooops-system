import type {ResilienceClassificationResult, ResilienceRetryClassifier} from '@ooopsstudio/core/contracts/resilience'

function safeProperty(value: unknown, key: string): unknown {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	let current: object | null = value as object
	try {
		for (let depth = 0; current && depth < 8; depth++) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) return 'value' in descriptor ? descriptor.value : undefined
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function numericRetryAfter(value: unknown, now: number): number | undefined {
	if (typeof value !== 'string' || value.length > 128) return undefined
	const trimmed = value.trim()
	if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
		const milliseconds = Number(trimmed) * 1_000
		return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined
	}
	const date = Date.parse(trimmed)
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

const headersPrototype = globalThis.Headers?.prototype
const headersGet = headersPrototype && Object.getOwnPropertyDescriptor(headersPrototype, 'get')?.value as unknown

function retryAfter(error: unknown, now: number): number | undefined {
	const headers = safeProperty(error, 'headers')
	let value = safeProperty(headers, 'retry-after')
	if (value === undefined && headersPrototype && typeof headersGet === 'function' && headers && typeof headers === 'object') {
		try {
			if (Object.getPrototypeOf(headers) === headersPrototype) value = Reflect.apply(headersGet, headers, ['retry-after'])
		} catch { /* malformed or proxy-backed Headers value */ }
	}
	return numericRetryAfter(
		value ?? safeProperty(error, 'retryAfter'),
		now
	)
}

const CONNECTION_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '08007', '57P01', '57P02', '57P03', '53300', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'])
const SAFE_WRITE_CONNECTION_CODES = new Set(['08001', '08004', '57P03', '53300', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
const SERIALIZATION_CODES = new Set(['40001', '40P01'])

export function classifyBuiltinResilienceError(name: ResilienceRetryClassifier, error: unknown, now: number): ResilienceClassificationResult {
	const rawCode = safeProperty(error, 'code')
	const code = typeof rawCode === 'string' && rawCode.length <= 64 ? rawCode : undefined
	const status = safeProperty(error, 'status')
	const aborted = safeProperty(error, 'name') === 'AbortError' || code === 'ABORT_ERR'
	if (aborted) return {retryable: false}
	if (name === 'db-read') return {retryable: typeof code === 'string' && (CONNECTION_CODES.has(code) || SERIALIZATION_CODES.has(code))}
	if (name === 'db-write') return {retryable: typeof code === 'string' && (SERIALIZATION_CODES.has(code) || SAFE_WRITE_CONNECTION_CODES.has(code)), ambiguousCompletion: code === '08007'}
	if (name === 'db-transaction') return {retryable: typeof code === 'string' && SERIALIZATION_CODES.has(code)}
	if (name === 'http' || name === 'storage') {
		if (status === 429) return {retryable: true, delayMs: retryAfter(error, now)}
		if (typeof status === 'number' && [408, 500, 502, 503, 504].includes(status)) return {retryable: true, ambiguousCompletion: true}
		if (typeof code === 'string' && SAFE_WRITE_CONNECTION_CODES.has(code)) return {retryable: true}
		return {retryable: typeof code === 'string' && CONNECTION_CODES.has(code), ...(typeof code === 'string' && CONNECTION_CODES.has(code) ? {ambiguousCompletion: true} : {})}
	}
	return {retryable: false}
}
