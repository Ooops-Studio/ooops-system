/**
 * @file HTTP OTLP exporter for tracing spans.
 * Exports spans via OTLP/HTTP/JSON to collectors.
 */
import {types as utilTypes} from 'node:util'
import {gzipSync} from 'node:zlib'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {createSafeAbortController} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'
import {serializeSpansToOtlpJson} from '@ooopsstudio/core/runtime/tracing'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import {
	addNativeSet,
	deleteNativeSet,
	deleteNativeMap,
	hasNativeSet,
	pushNativeArray,
	setNativeMap,
	sizeNativeMap,
	snapshotNativeMapValues
} from '../../core/native-runtime'
import {
	createNativePromise,
	observeNativePromiseSettlement,
	raceNativePromises
} from '../../core/native-runtime'
import {
	captureTimerOwnership,
	clearTimerSafely,
	estimateSpanSize,
	invokeNativeAsync,
	snapshotSpanRecord
} from '../../core/processor-utils'
import type {TimerOwnership} from '../../core/processor-utils'
import type {SpanExporterPort} from '../../types/ports'
import {captureCapability, captureClock, snapshotDataFields} from '../../utils/capabilities'
/**
 * Options for HTTP OTLP exporter.
 */
export interface HttpOtlpExporterOptions {
	/** OTLP endpoint URL */
	endpoint: string
	/** Optional headers (e.g., Authorization) */
	headers?: Record<string, string>
	/** Request timeout in milliseconds */
	timeoutMs?: number
	/** Optional gzip content encoding */
	compress?: boolean
	/** Epoch clock used for deterministic HTTP-date Retry-After handling. */
	clock?: Clock
	/** Internal transport override captured at construction. */
	transport?: typeof fetch
}
function parseRetryAfter(header: string | null, now: number): number | undefined {
	if (!header || typeof header !== 'string' || header.length > 256) {
		return undefined
	}
	const seconds = matches(/^\d+$/u, header) ? Number(header) : Number.NaN
	if (nativeNumberIsFinite(seconds)) {
		return Math.min(seconds * 1000, 2_147_483_647)
	}
	// Do not let Date.parse reinterpret malformed delta-seconds such as `1.5`
	// or `1e3` as calendar dates.
	if (matches(/^[\d.eE+\-\s]+$/u, header)) return undefined
	const dateMs = nativeDateParse(header)
	if (nativeNumberIsFinite(dateMs)) {
		return Math.min(Math.max(0, dateMs - now), 2_147_483_647)
	/* v8 ignore next -- defensive branch not constructible through the public tracing API */
	}
	return undefined
}
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'host', 'transfer-encoding'])
const MAX_OTLP_RESPONSE_BYTES = 64 * 1_024
const MAX_OTLP_RESPONSE_CHUNKS = 4_096
const MAX_OTLP_REQUEST_BYTES = 16 * 1_024 * 1_024
const MAX_OTLP_SPANS_PER_REQUEST = 10_000
const REQUEST_FAILED = 'OTLP export request failed'
const nativeIsProxy = utilTypes.isProxy
const nativeArrayBufferIsView = ArrayBuffer.isView
const nativeArrayIsArray = Array.isArray
const nativeDateParse = Date.parse
const nativeJsonParse = JSON.parse
const nativeJsonStringify = JSON.stringify
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectDefineProperty = Object.defineProperty
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectHasOwn = Object.hasOwn
const nativeReflectApply = Reflect.apply
const nativeReflectOwnKeys = Reflect.ownKeys
const nativeRegExpTest = RegExp.prototype.test
const nativeStringStartsWith = String.prototype.startsWith
const nativeTextDecoderDecode = TextDecoder.prototype.decode
const nativeTypedArrayByteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype), 'byteLength'
)?.get
const RESPONSE_DATA_FIELDS = ['ok', 'status', 'headers', 'body'] as const
const nativeResponseGetters = Object.freeze(Object.fromEntries(RESPONSE_DATA_FIELDS.map((key) => [
	key, typeof Response === 'function' ? Object.getOwnPropertyDescriptor(Response.prototype, key)?.get : undefined
]))) as Readonly<Record<(typeof RESPONSE_DATA_FIELDS)[number], ((this: Response) => unknown) | undefined>>
function matches(pattern: RegExp, value: string): boolean {
	return nativeReflectApply(nativeRegExpTest, pattern, [value]) as boolean
}
/**
 * HTTP OTLP exporter: sends spans via HTTP POST to OTLP endpoint.
 */
export class HttpOtlpExporter implements SpanExporterPort {
	private readonly endpoint: string
	private readonly headers: Record<string, string>
	private readonly timeoutMs: number
	private readonly compress: boolean
	private readonly clock: Clock
	private readonly transport: typeof fetch
	private readonly timers: TimerOwnership
	private readonly activeRequests = new Map<Promise<unknown>, AbortController>()
	private shutdownRequested = false
	constructor(options: HttpOtlpExporterOptions) {
		const configured = snapshotExporterOptions(options)
		const {
			endpoint,
			headers = {},
			timeoutMs = 5000,
			compress = false,
			clock = createSystemClock(),
			transport = globalThis.fetch
		} = configured
		if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 4_096) {
			throw new Error('Tracing OTLP endpoint must be a non-empty URL of at most 4096 characters')
		}
		let endpointUrl: URL
		try { endpointUrl = new URL(endpoint) } catch { throw new Error('Tracing OTLP endpoint must be a valid URL') }
		if (endpointUrl.protocol !== 'https:' && endpointUrl.protocol !== 'http:') throw new Error('Tracing OTLP endpoint must use HTTP or HTTPS')
		if (endpointUrl.username || endpointUrl.password) throw new Error('Tracing OTLP endpoint must not contain URL credentials; use headers instead')
		const safeHeaders = snapshotHeaders(headers)
		if (typeof timeoutMs !== 'number' || !nativeNumberIsSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
			throw new Error('Tracing OTLP timeoutMs must be between 1 and 2147483647')
		}
		if (typeof compress !== 'boolean') {
			throw new Error(`Tracing OTLP compress must be a boolean, got ${typeof compress}`)
		}
		if (typeof transport !== 'function') throw new Error('Tracing OTLP transport required')
		for (const key of Object.keys(safeHeaders)) {
			if (RESERVED_HEADERS.has(key.toLowerCase())) throw new Error(`Tracing OTLP header "${key}" is managed by the exporter`)
		}
		this.endpoint = endpointUrl.toString()
		this.headers = Object.freeze({
			'Content-Type': 'application/json',
			...(compress ? {'Content-Encoding': 'gzip'} : {}),
			...safeHeaders
		})
		this.timeoutMs = timeoutMs
		this.compress = compress
		this.clock = captureClock(clock as Clock)
		this.transport = (...args) => Reflect.apply(transport, globalThis, args)
		this.timers = captureTimerOwnership()
	}
	async export(spans: readonly SpanRecord[]) {
		if (this.shutdownRequested) {
			return {status: 'permanent-failure' as const, acceptedCount: 0, error: new Error('OTLP exporter closed')}
		}
		const admitted = snapshotSpanBatch(spans)
		if (!admitted) {
			return {status: 'permanent-failure' as const, acceptedCount: 0, error: new Error('OTLP export input is unsafe')}
		}
		if (admitted.length === 0) {
			return {
				status: 'success' as const,
				acceptedCount: 0
			}
		}
		const safeSpans: SpanRecord[] = []
		let estimatedBytes = 0
		for (let index = 0; index < admitted.length; index++) {
			const span = admitted[index]!
			const snapshot = snapshotSpanRecord(span)
			const size = snapshot ? estimateSpanSize(snapshot) : Number.POSITIVE_INFINITY
			if (!snapshot || !nativeNumberIsFinite(size) || size > MAX_OTLP_REQUEST_BYTES - estimatedBytes) {
				return {
					status: 'permanent-failure' as const,
					acceptedCount: 0,
					error: new Error('OTLP export input is unsafe or exceeds 16 MiB')
				}
			}
			estimatedBytes += size
			pushNativeArray(safeSpans, snapshot)
		}
		spans = Object.freeze(safeSpans)
		let body: string | Uint8Array
		try {
			// OTLP wraps every attribute value in a typed object. A batch containing
			// many tiny nested values can therefore be far larger than its source
			// SpanRecord JSON. Preflight one span at a time and sum those complete
			// request sizes: separate one-span envelopes are an upper bound for the
			// grouped batch, while keeping the largest intermediate allocation bound
			// to one already-admitted span.
			let serializedUpperBound = 0
			for (const span of spans) {
				const singleSpanBytes = byteSize(serializeSpansToOtlpJson([span]))
				if (singleSpanBytes > MAX_OTLP_REQUEST_BYTES - serializedUpperBound) {
					return {status: 'permanent-failure' as const, acceptedCount: 0, error: new Error('OTLP export payload exceeds 16 MiB')}
				}
				serializedUpperBound += singleSpanBytes
			}
			const serialized = serializeSpansToOtlpJson(spans)
			if (byteSize(serialized) > MAX_OTLP_REQUEST_BYTES) {
				return {status: 'permanent-failure' as const, acceptedCount: 0, error: new Error('OTLP export payload exceeds 16 MiB')}
			}
			body = this.compress ? new Uint8Array(gzipSync(serialized)) : serialized
		} catch {
			return {
				status: 'permanent-failure' as const,
				acceptedCount: 0,
				error: new Error('OTLP span serialization failed')
			}
		}
		if (sizeNativeMap(this.activeRequests) >= 16) {
			return {
				status: 'retryable' as const,
				acceptedCount: 0,
				error: new Error('OTLP capacity exceeded')
			}
		}
		const controller = createSafeAbortController()
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		let rejectTimeout!: (error: Error) => void
		let deadlineFired = false
		const timeoutFailure = createNativePromise<never>((_resolve, reject) => { rejectTimeout = reject })
		try {
			// Secure cancellation before starting physical delivery. Otherwise a
			// failed timer allocation could report a retryable outcome while the
			// first request remains live, allowing duplicate span delivery.
			timeoutId = this.timers.schedule(() => {
				deadlineFired = true
				try { controller.abort() } catch { /* timeout remains authoritative */ }
				rejectTimeout(new Error())
			}, this.timeoutMs)
		} catch {
			return {status: 'retryable' as const, acceptedCount: 0, error: new Error(REQUEST_FAILED)}
		}
		try { timeoutId.unref?.() } catch { /* timer reference state is best-effort */ }
		if (deadlineFired) {
			// The deadline promise was rejected before Promise.race could install
			// its handler. Contain that already-authoritative rejection explicitly.
			observeNativePromiseSettlement(timeoutFailure, () => undefined, () => undefined)
			return {status: 'retryable' as const, acceptedCount: 0, error: new Error(REQUEST_FAILED)}
		}
		const request = invokeNativeAsync<Response>(() => this.transport(this.endpoint, {
			method: 'POST',
			headers: {...this.headers},
			body,
			signal: controller.signal,
			redirect: 'error'
		}), 'Tracing OTLP transport')
		const operation = (async() => {
			try {
				const response = await request
				const ok = readResponseDataField(response, 'ok')
				const rawStatus = readResponseDataField(response, 'status')
				const status = rawStatus === undefined && ok === true ? 200 : rawStatus
				if (typeof ok !== 'boolean' || typeof status !== 'number') throw new TypeError('Invalid OTLP response')
				if (ok) {
					let rejectedCount: number
					try {
						rejectedCount = await readRejectedSpanCount(response, spans.length)
					} catch {
						disposeResponseBody(response)
						// A 2xx response means the collector may already have committed the
						// batch. Retrying after an invalid acknowledgement would duplicate spans.
						return {
							status: 'permanent-failure' as const,
							acceptedCount: 0,
							error: new Error('OTLP collector returned an invalid success response')
						}
					}
					if (rejectedCount > 0) {
						return {
							status: 'partial' as const,
							acceptedCount: spans.length - rejectedCount,
							error: new Error(`OTLP collector rejected ${rejectedCount} spans`)
						}
					}
					return {
						status: 'success' as const,
						acceptedCount: spans.length
					}
				}
				disposeResponseBody(response)
				const responseHeaders = readResponseDataField(response, 'headers')
				const getHeader = captureCapability<[string], string | null>(responseHeaders, 'get')
				const retryAfterMs = parseRetryAfter(getHeader?.('retry-after') ?? null, this.clock.now())
				if (status === 429) {
					return {
						status: 'throttled' as const,
						acceptedCount: 0,
						/* v8 ignore next -- defensive branch not constructible through the public tracing API */
						...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
						error: new Error(`OTLP export throttled: HTTP ${status}`)
					}
				}
				if (status >= 500 || status === 408) {
					return {
						status: 'retryable' as const,
						acceptedCount: 0,
						...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
						error: new Error(`OTLP export failed: HTTP ${status}`)
					}
				}
				return {
					status: 'permanent-failure' as const,
					acceptedCount: 0,
					error: new Error(`OTLP export failed: HTTP ${status}`)
				}
			} catch(error) {
				const code = error && typeof error === 'object'
					? nativeObjectGetOwnPropertyDescriptor(error, 'code')?.value : undefined
				if (typeof code === 'string' && nativeReflectApply(
					nativeStringStartsWith, code, ['PUBLIC_HTTPS_']
				) as boolean) {
					return {
						status: 'permanent-failure' as const,
						acceptedCount: 0,
						error: Object.assign(new Error('Production tracing OTLP endpoint failed public-network policy'), {code})
					}
				}
				return {
					status: 'retryable' as const,
					acceptedCount: 0,
					// Fetch implementations may include the complete endpoint in their error
					// messages. Endpoints can contain credentials or query tokens, so never
					// let that implementation detail enter tracing diagnostics.
					error: new Error(REQUEST_FAILED)
				}
			}
		})()
		setNativeMap(this.activeRequests, operation, controller)
		observeNativePromiseSettlement(
			operation,
			() => deleteNativeMap(this.activeRequests, operation),
			() => deleteNativeMap(this.activeRequests, operation)
		)
		try {
			const result = await raceNativePromises([operation, timeoutFailure])
			if (deadlineFired) {
				return {
					status: 'permanent-failure' as const,
					acceptedCount: 0,
					error: new Error('OTLP export timed out with an indeterminate delivery outcome')
				}
			}
			return result
		} catch {
			if (deadlineFired) {
				// Abort is advisory: a non-cooperative transport may still commit the
				// request. Never classify that physical outcome as safe to replay.
				return {
					status: 'permanent-failure' as const,
					acceptedCount: 0,
					error: new Error('OTLP export timed out with an indeterminate delivery outcome')
				}
			}
			return {status: 'retryable' as const, acceptedCount: 0, error: new Error(REQUEST_FAILED)}
		} finally {
			clearTimerSafely(timeoutId, this.timers)
		}
	}
	async shutdown(): Promise<void> {
		this.shutdownRequested = true
		const controllers = snapshotNativeMapValues(this.activeRequests)
		for (let index = 0; index < controllers.length; index++) {
			const controller = controllers[index]!
			try { controller.abort() } catch { /* shutdown admission remains closed */ }
		}
	}
}

function snapshotSpanBatch(value: unknown): SpanRecord[] | undefined {
	if (!value || typeof value !== 'object' || nativeIsProxy(value) || !nativeArrayIsArray(value)) return undefined
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(value, 'length')
		const length = descriptor && 'value' in descriptor ? descriptor.value : undefined
		if (!nativeNumberIsSafeInteger(length) || length < 0 || length > MAX_OTLP_SPANS_PER_REQUEST) return undefined
		const result: SpanRecord[] = []
		for (let index = 0; index < length; index++) {
			const entry = nativeObjectGetOwnPropertyDescriptor(value, String(index))
			if (!entry?.enumerable || !('value' in entry)) return undefined
			pushNativeArray(result, entry.value as SpanRecord)
		}
		return result
	} catch { return undefined }
}

function readResponseDataField(response: unknown, key: (typeof RESPONSE_DATA_FIELDS)[number]): unknown {
	if (!response || (typeof response !== 'object' && typeof response !== 'function') || nativeIsProxy(response)) {
		throw new TypeError('Invalid OTLP response')
	}
	let current: object | null = response as object
	for (let depth = 0; current && depth < 16; depth++) {
		if (nativeIsProxy(current)) throw new TypeError('Invalid OTLP response')
		const descriptor = nativeObjectGetOwnPropertyDescriptor(current, key)
		if (descriptor) {
			if ('value' in descriptor) return descriptor.value
			const getter = nativeResponseGetters[key]
			if (!getter || descriptor.get !== getter) throw new TypeError('Invalid OTLP response')
			return nativeReflectApply(getter, response, [])
		}
		current = nativeObjectGetPrototypeOf(current)
	}
	return undefined
}

function disposeResponseBody(response: Response): void {
	try {
		const body = readResponseDataField(response, 'body')
		const cancel = captureCapability<[], unknown>(body, 'cancel')
		if (!cancel) return
		const disposal = invokeNativeAsync<void>(cancel, 'OTLP response body cancellation')
		observeNativePromiseSettlement(disposal, () => undefined, () => undefined)
	} catch { /* response disposal is best-effort */ }
}

function snapshotExporterOptions(options: unknown): Readonly<Record<string, unknown>> {
	return snapshotDataObject(options, new Set(['endpoint', 'headers', 'timeoutMs', 'compress', 'clock', 'transport']), 'Tracing OTLP exporter options')
}

function snapshotHeaders(headers: unknown): Readonly<Record<string, string>> {
	let values: Readonly<Record<string, unknown>>
	try {
		values = snapshotDataFields(headers, 100, 256)
	} catch {
		throw new TypeError('Tracing OTLP headers must be a closed plain data object with at most 100 fields')
	}
	const result: Record<string, string> = Object.create(null) as Record<string, string>
	const normalizedNames = new Set<string>()
	for (const [key, value] of Object.entries(values)) {
		if (!matches(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/u, key)) throw new Error('Tracing OTLP header names must be valid HTTP tokens')
		if (typeof value !== 'string' || value.length > 8_192 || byteSize(value) > 8_192 || matches(/[\0\r\n]/u, value)) {
			throw new Error(`Tracing OTLP header value for "${key}" is invalid`)
		}
		const normalizedName = key.toLowerCase()
		if (normalizedNames.has(normalizedName)) {
			throw new Error(`Tracing OTLP header "${key}" is duplicated case-insensitively`)
		}
		normalizedNames.add(normalizedName)
		result[key] = value
	}
	return Object.freeze(result)
}

function snapshotDataObject(
	value: unknown,
	allowed: ReadonlySet<string> | undefined,
	label: string
): Readonly<Record<string, unknown>> {
	try {
		return snapshotDataFields(value, allowed?.size ?? 256, allowed ? 64 : 256, allowed)
	} catch { throw new TypeError(`${label} must be a closed plain data object`) }
}

function invalidCollectorResponse(): never {
	throw new Error('Invalid OTLP collector success response')
}

async function readRejectedSpanCount(response: Response, batchSize: number): Promise<number> {
	const payload = await readBoundedResponsePayload(response)
	if (payload === undefined) return 0
	if (!payload || typeof payload !== 'object' || nativeArrayIsArray(payload)) {
		invalidCollectorResponse()
	}
	const payloadDescriptors = nativeObjectGetOwnPropertyDescriptors(payload)
	if (hasSymbolKey(payloadDescriptors)) {
		invalidCollectorResponse()
	}
	const partialDescriptor = payloadDescriptors.partialSuccess
	if (!partialDescriptor) return 0
	if (!('value' in partialDescriptor)) invalidCollectorResponse()
	const partial = partialDescriptor.value
	if (!partial || typeof partial !== 'object' || nativeArrayIsArray(partial)) {
		invalidCollectorResponse()
	}
	const prototype = nativeObjectGetPrototypeOf(partial)
	if (prototype !== Object.prototype && prototype !== null) {
		invalidCollectorResponse()
	}
	const partialDescriptors = nativeObjectGetOwnPropertyDescriptors(partial)
	if (hasSymbolKey(partialDescriptors)) {
		invalidCollectorResponse()
	}
	const rejectedDescriptor = partialDescriptors.rejectedSpans
	if (!rejectedDescriptor) return 0
	if (!('value' in rejectedDescriptor)) invalidCollectorResponse()
	const raw = rejectedDescriptor.value
	if (raw === undefined) return 0
	const count = typeof raw === 'string' && matches(/^\d+$/u, raw) ? Number(raw) : raw
	if (!nativeNumberIsSafeInteger(count) || Number(count) < 0 || Number(count) > batchSize) {
		invalidCollectorResponse()
	}
	return Number(count)
}

async function readBoundedResponsePayload(response: Response): Promise<unknown | undefined> {
	const headers = readResponseDataField(response, 'headers')
	const getHeader = captureCapability<[string], string | null>(headers, 'get')
	const contentLength = getHeader?.('content-length')
	if (contentLength && contentLength.length <= 32 && matches(/^\d+$/u, contentLength) && Number(contentLength) > MAX_OTLP_RESPONSE_BYTES) {
		invalidCollectorResponse()
	}
	const body = readResponseDataField(response, 'body')
	const getReader = captureCapability<[], unknown>(body, 'getReader')
	const reader = getReader?.()
	if (reader) {
		const read = captureCapability<[], unknown>(reader, 'read')
		const cancel = captureCapability<[], unknown>(reader, 'cancel')
		if (!read) invalidCollectorResponse()
		const decoder = new TextDecoder()
		let decoded = ''
		let totalBytes = 0
		let chunks = 0
		while (true) {
			const rawChunk = await invokeNativeAsync<unknown>(
				read, 'OTLP response stream read'
			)
			const chunk = snapshotStreamReadResult(rawChunk)
			if (chunk.done) break
			if (++chunks > MAX_OTLP_RESPONSE_CHUNKS) {
				try { if (cancel) await invokeNativeAsync<void>(cancel, 'OTLP response stream cancellation') } catch { /* response disposal is best-effort */ }
				invalidCollectorResponse()
			}
			totalBytes += chunk.byteLength
			if (totalBytes > MAX_OTLP_RESPONSE_BYTES) {
				try { if (cancel) await invokeNativeAsync<void>(cancel, 'OTLP response stream cancellation') } catch { /* response disposal is best-effort */ }
				invalidCollectorResponse()
			}
			decoded += nativeReflectApply(nativeTextDecoderDecode, decoder, [chunk.value, {stream: true}]) as string
		}
		decoded += nativeReflectApply(nativeTextDecoderDecode, decoder, []) as string
		if (decoded.length === 0) return undefined
		return nativeJsonParse(decoded) as unknown
	}
	const textResponse = captureCapability<[], unknown>(response, 'text')
	if (textResponse) {
		const text = await invokeNativeAsync<string>(textResponse, 'OTLP response text')
		if (typeof text !== 'string' || text.length > MAX_OTLP_RESPONSE_BYTES || byteSize(text) > MAX_OTLP_RESPONSE_BYTES) {
			invalidCollectorResponse()
		}
		return text.length === 0 ? undefined : nativeJsonParse(text) as unknown
	}
	const jsonResponse = captureCapability<[], unknown>(response, 'json')
	if (jsonResponse) {
		const payload = await invokeNativeAsync<unknown>(jsonResponse, 'OTLP response JSON')
		const snapshot = snapshotResponseJson(payload, 0, {nodes: 0, stringUnits: 0, ancestors: new Set<object>()})
		const serialized = nativeJsonStringify(snapshot)
		if (serialized === undefined || byteSize(serialized) > MAX_OTLP_RESPONSE_BYTES) {
			invalidCollectorResponse()
		}
		return snapshot
	}
	return undefined
}

function snapshotResponseJson(
	value: unknown,
	depth: number,
	state: {nodes: number; stringUnits: number; ancestors: Set<object>}
): unknown {
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'string') {
		if (value.length > MAX_OTLP_RESPONSE_BYTES - state.stringUnits) {
			invalidCollectorResponse()
		}
		state.stringUnits += value.length
		return value
	}
	if (typeof value === 'number') {
		if (!nativeNumberIsFinite(value)) invalidCollectorResponse()
		return value
	}
	if (!value || typeof value !== 'object' || depth >= 32 || ++state.nodes > 10_000) {
		invalidCollectorResponse()
	}
	if (hasNativeSet(state.ancestors, value)) invalidCollectorResponse()
	addNativeSet(state.ancestors, value)
	try {
		if (nativeArrayIsArray(value)) {
			const lengthDescriptor = nativeObjectGetOwnPropertyDescriptor(value, 'length')
			const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
			if (!nativeNumberIsSafeInteger(length) || length < 0 || length > 10_000) {
				invalidCollectorResponse()
			}
			const result: unknown[] = []
			for (let index = 0; index < length; index++) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(value, String(index))
				if (!descriptor || !('value' in descriptor)) invalidCollectorResponse()
				pushNativeArray(result, snapshotResponseJson(descriptor.value, depth + 1, state))
			}
			return result
		}
		if (!isPlainResponseObject(value)) invalidCollectorResponse()
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		let entries = 0
		for (const key in value) {
			if (++entries > 1_000) invalidCollectorResponse()
			if (key.length > 1_024 || key.length > MAX_OTLP_RESPONSE_BYTES - state.stringUnits) {
				invalidCollectorResponse()
			}
			if (!nativeObjectHasOwn(value, key)) continue
			state.stringUnits += key.length
			const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable) continue
			if (!('value' in descriptor)) invalidCollectorResponse()
			nativeObjectDefineProperty(result, key, {
				value: snapshotResponseJson(descriptor.value, depth + 1, state),
				enumerable: true,
				configurable: true,
				writable: true
			})
		}
		return result
	} finally {
		deleteNativeSet(state.ancestors, value)
	}
}

function hasSymbolKey(value: object): boolean {
	const keys = nativeReflectOwnKeys(value)
	for (let index = 0; index < keys.length; index++) if (typeof keys[index] !== 'string') return true
	return false
}

function isPlainResponseObject(value: object): boolean {
	if (nativeIsProxy(value)) return false
	const prototype = nativeObjectGetPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function snapshotStreamReadResult(value: unknown): {done: boolean; value: Uint8Array; byteLength: number} {
	if (!value || typeof value !== 'object' || nativeIsProxy(value)) invalidCollectorResponse()
	const doneDescriptor = nativeObjectGetOwnPropertyDescriptor(value, 'done')
	const valueDescriptor = nativeObjectGetOwnPropertyDescriptor(value, 'value')
	if (!doneDescriptor || !('value' in doneDescriptor) || typeof doneDescriptor.value !== 'boolean') {
		invalidCollectorResponse()
	}
	if (doneDescriptor.value) return {done: true, value: new Uint8Array(), byteLength: 0}
	const chunk = valueDescriptor && 'value' in valueDescriptor ? valueDescriptor.value : undefined
	if (!chunk || typeof chunk !== 'object' || nativeIsProxy(chunk) || !nativeArrayBufferIsView(chunk)
		|| typeof nativeTypedArrayByteLength !== 'function') invalidCollectorResponse()
	const byteLength = nativeReflectApply(nativeTypedArrayByteLength, chunk, []) as number
	return {done: false, value: chunk as Uint8Array, byteLength}
}
/**
 * Create an HTTP OTLP exporter.
 */
export function createHttpOtlpExporter(options: HttpOtlpExporterOptions): HttpOtlpExporter {
	return new HttpOtlpExporter(options)
}
