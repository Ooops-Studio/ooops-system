import {MAX_METRICS_TIMER_MS} from '../../constants'
import {safeJsonStringify} from '../../utils/safe-json-stringify'

import {sendPublicOtlpHttps} from './otlp-public-http'

export interface OtlpExportError extends Error {
	statusCode?: number;
	retryable: boolean;
	code: string;
	retryAfterMs?: number;
}

const MAX_DIAGNOSTIC_LENGTH = 1024
const MAX_OTLP_RESPONSE_BYTES = 64 * 1024
const UINT64_MAX = BigInt('18446744073709551615')

export interface OtlpHttpResult {
	readonly partialSuccess?: {
		readonly rejectedDataPoints: string
		readonly errorMessage?: string
	}
}

export function isSensitiveOtlpHeaderName(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/gu, '')
	return normalized.includes('authorization') || normalized.includes('cookie')
		|| normalized.includes('token') || normalized.includes('secret')
		|| normalized.includes('password') || normalized.includes('apikey')
}

function readOwnDataProperty(value: unknown, key: PropertyKey): unknown {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch {
		return undefined
	}
}

function sanitizeDiagnostic(value: unknown): string {
	const safeValue = typeof value === 'string'
		? value
		: value === null || value === undefined || typeof value === 'number'
			|| typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol'
			? String(value)
			: 'OTLP transport failed'
	return Array.from(safeValue.slice(0, MAX_DIAGNOSTIC_LENGTH), (character) => {
		const code = character.codePointAt(0) ?? 0
		return code < 32 || code === 127 ? ' ' : character
	}).join('')
}

function classifyStatus(status: number): {retryable: boolean; code: string} {
	return {
		retryable: status === 429 || status === 502 || status === 503 || status === 504,
		code: `http_${status}`
	}
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined
	const seconds = Number(value)
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_METRICS_TIMER_MS, seconds * 1000)
	const timestamp = Date.parse(value)
	if (!Number.isFinite(timestamp)) return undefined
	return Math.min(MAX_METRICS_TIMER_MS, Math.max(0, timestamp - now))
}

function typedError(
	message: string,
	options: {
		statusCode?: number;
		retryAfterMs?: number;
		retryable?: boolean;
		code?: string;
	} = {}
): OtlpExportError {
	const classified =
		options.statusCode === undefined
			? undefined
			: classifyStatus(options.statusCode)
	const error = new Error(message) as OtlpExportError
	if (options.statusCode !== undefined) error.statusCode = options.statusCode
	if (options.retryAfterMs !== undefined)
		error.retryAfterMs = options.retryAfterMs
	error.retryable = options.retryable ?? classified?.retryable ?? true
	error.code = options.code ?? classified?.code ?? 'otlp_export_failed'
	return error
}

async function compress(
	data: string,
	enabled: boolean,
	threshold: number
): Promise<{body: string | Uint8Array; contentEncoding?: string}> {
	if (!enabled || Buffer.byteLength(data, 'utf8') < threshold)
		return {body: data}
	const [{gzip}, {promisify}] = await Promise.all([
		import('node:zlib'),
		import('node:util')
	])
	return {
		body: await promisify(gzip)(Buffer.from(data, 'utf8')),
		contentEncoding: 'gzip'
	}
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel()
	} catch {
		// Delivery has already completed. Cleanup failures must not trigger retries.
	}
}

async function readBoundedResponseBody(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length'))
	if (Number.isFinite(declaredLength) && declaredLength > MAX_OTLP_RESPONSE_BYTES) {
		throw typedError('OTLP response body exceeds the 65536-byte limit', {
			retryable: false, code: 'otlp_response_too_large'
		})
	}
	if (!response.body || typeof response.body.getReader !== 'function') return ''
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let bytes = 0
	let body = ''
	try {
		while (true) {
			const {done, value} = await reader.read()
			if (done) break
			bytes += value.byteLength
			if (bytes > MAX_OTLP_RESPONSE_BYTES) {
				throw typedError('OTLP response body exceeds the 65536-byte limit', {
					retryable: false, code: 'otlp_response_too_large'
				})
			}
			body += decoder.decode(value, {stream: true})
		}
		return body + decoder.decode()
	} finally {
		reader.releaseLock()
	}
}

function parseOtlpSuccessBody(body: string): OtlpHttpResult {
	if (body.trim().length === 0) return {}
	let parsed: unknown
	try { parsed = JSON.parse(body) } catch {
		throw typedError('OTLP success response body is not valid JSON', {
			retryable: false, code: 'otlp_invalid_response'
		})
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw typedError('OTLP success response body is invalid', {
			retryable: false, code: 'otlp_invalid_response'
		})
	}
	const partial = readOwnDataProperty(parsed, 'partialSuccess')
		?? readOwnDataProperty(parsed, 'partial_success')
	if (partial === undefined) return {}
	if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
		throw typedError('OTLP partial success response is invalid', {
			retryable: false, code: 'otlp_invalid_response'
		})
	}
	const rejectedValue = readOwnDataProperty(partial, 'rejectedDataPoints')
		?? readOwnDataProperty(partial, 'rejected_data_points') ?? '0'
	const rejectedDataPoints = typeof rejectedValue === 'string' && /^\d{1,20}$/u.test(rejectedValue)
		&& BigInt(rejectedValue) <= UINT64_MAX
		? String(BigInt(rejectedValue))
		: typeof rejectedValue === 'number' && Number.isSafeInteger(rejectedValue) && rejectedValue >= 0
			? String(rejectedValue) : undefined
	if (rejectedDataPoints === undefined) {
		throw typedError('OTLP partial success rejected data point count is invalid', {
			retryable: false, code: 'otlp_invalid_response'
		})
	}
	const rawMessage = readOwnDataProperty(partial, 'errorMessage')
		?? readOwnDataProperty(partial, 'error_message')
	const errorMessage = typeof rawMessage === 'string' && rawMessage.length > 0
		? sanitizeDiagnostic(rawMessage) : undefined
	return {
		partialSuccess: {
			rejectedDataPoints,
			...(errorMessage ? {errorMessage} : {})
		}
	}
}

export async function sendOtlpHttp(
	data: unknown,
	options: {
		readonly endpoint: string;
		readonly headers: Record<string, string>;
		readonly timeout: number;
		readonly allowedHeaders: ReadonlySet<string>;
		readonly enableGzip: boolean;
		readonly gzipThresholdBytes: number;
		readonly requirePublicEndpoint: boolean;
	}
): Promise<OtlpHttpResult> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), options.timeout)
	try {
		const compressed = await compress(
			safeJsonStringify(data),
			options.enableGzip,
			options.gzipThresholdBytes
		)
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...options.headers,
			...(compressed.contentEncoding
				? {'Content-Encoding': compressed.contentEncoding}
				: {})
		}
		if (options.requirePublicEndpoint) {
			const response = await sendPublicOtlpHttps(
				options.endpoint, headers, compressed.body, controller.signal)
			if (response.status < 200 || response.status >= 300) {
				const retryAfterMs = parseRetryAfter(response.retryAfter)
				throw typedError(
					`OTLP export failed: ${response.status} ${sanitizeDiagnostic(response.statusText)}`,
					{statusCode: response.status, ...(retryAfterMs !== undefined ? {retryAfterMs} : {})}
				)
			}
			return parseOtlpSuccessBody(response.body)
		}
		const response = await fetch(options.endpoint, {
			method: 'POST', headers, body: compressed.body, redirect: 'error', signal: controller.signal
		})
		try {
			if (!response.ok) {
				const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
				throw typedError(
					`OTLP export failed: ${response.status} ${sanitizeDiagnostic(response.statusText)}`,
					{
						statusCode: response.status,
						...(retryAfterMs !== undefined ? {retryAfterMs} : {})
					}
				)
			}
			return parseOtlpSuccessBody(await readBoundedResponseBody(response))
		} finally {
			await cancelResponseBody(response)
		}
	} catch(error) {
		const errorMessage = readOwnDataProperty(error, 'message')
		let message = sanitizeDiagnostic(typeof errorMessage === 'string' ? errorMessage : error)
		for (const [key, value] of Object.entries(options.headers))
			if (
				isSensitiveOtlpHeaderName(key) ||
				!options.allowedHeaders.has(key.toLowerCase())
			)
				if (value.length > 0) message = message.replaceAll(value, '[REDACTED]')
		const statusCode = readOwnDataProperty(error, 'statusCode')
		const retryAfterMs = readOwnDataProperty(error, 'retryAfterMs')
		const retryable = readOwnDataProperty(error, 'retryable')
		const code = readOwnDataProperty(error, 'code')
		throw typedError(message, {
			...(typeof statusCode === 'number' ? {statusCode} : {}),
			...(typeof retryAfterMs === 'number' ? {retryAfterMs} : {}),
			...(typeof retryable === 'boolean' ? {retryable} : {}),
			...(typeof code === 'string' ? {code} : {})
		})
	} finally {
		clearTimeout(timeout)
	}
}
