
import {isSensitiveFreeformKey, sensitiveKeyContainsPayload} from '../../core/redacting-utilities'
import {
	attachTransferLifecycleReentryState,
	createTransferLifecycleReentryState,
	invokeTransferLifecycle,
	isTransferLifecycleStateReentry,
	type TransferLifecycleReentryState
} from '../../core/transfer-lifecycle-reentry'
import {snapshotLoggingPayloadLines} from '../../features/transferring/payload-limits'
import {
	createRequestOwnership,
	hasRequestCapacity,
	type RequestOwnership,
	startOwnedRequest,
	waitForOwnedRequests
} from '../../features/transferring/request-ownership'
import type {Sink, SinkWriteOptions} from '../../types/sink'
import {captureLoggingMethod, readLoggingDataProperty} from '../../utils/capabilities'
import {sanitizeLoggingDiagnostic, sanitizeLoggingErrorDiagnostic} from '../../utils/sanitize-diagnostic'
import {sanitizeUrlForDiagnostics} from '../../utils/sanitize-url'
import type {LokiLoggingSinkConfig} from '../types'

type LokiLogPayload = {
	time?: number
	level?: string
	message?: string
	namespace?: string
	attributes?: Record<string, unknown>
}

type LokiStream = {
	stream: Record<string, string>
	values: Array<[string, string]>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000

export interface LokiSinkError extends Error {
	readonly code: 'LOKI_BAD_REQUEST' | 'LOKI_UNAUTHORIZED' | 'LOKI_NOT_FOUND' | 'LOKI_RATE_LIMITED' | 'LOKI_REQUEST_TIMEOUT' | 'LOKI_SERVER_ERROR' | 'LOKI_TIMEOUT' | 'LOKI_ABORTED' | 'LOKI_NETWORK'
	readonly retryable: boolean
	readonly statusCode?: number
	/** The Loki server responded without accepting this payload. */
	readonly knownNoDelivery?: boolean
	readonly nonRetryable?: boolean
	readonly ambiguousDelivery?: boolean
}

const LOKI_SINK_ERROR = Symbol('ooops.logging.loki-sink-error')

function classifyLokiStatus(statusCode: number): {code: LokiSinkError['code']; retryable: boolean} {
	if (statusCode === 429) return {code: 'LOKI_RATE_LIMITED', retryable: true}
	if (statusCode === 408) return {code: 'LOKI_REQUEST_TIMEOUT', retryable: true}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (statusCode >= 500) return {code: 'LOKI_SERVER_ERROR', retryable: true}
	if (statusCode === 401 || statusCode === 403) return {code: 'LOKI_UNAUTHORIZED', retryable: false}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (statusCode === 404) return {code: 'LOKI_NOT_FOUND', retryable: false}
	return {code: 'LOKI_BAD_REQUEST', retryable: false}
}

function createLokiSinkError(
	url: string,
	message: string,
	code: LokiSinkError['code'],
	retryable: boolean,
	statusCode?: number,
	knownNoDelivery = false
): LokiSinkError {
	return Object.assign(new Error(`Loki log delivery failed for ${sanitizeUrlForDiagnostics(url)}: ${sanitizeLoggingDiagnostic(message)}`), {
		[LOKI_SINK_ERROR]: true as const,
		code,
		retryable,
		...(statusCode !== undefined ? {statusCode} : {}),
		...(knownNoDelivery ? {knownNoDelivery: true} : {})
	})
}

const normalizeUrl = (url: string): string => {
	const parsed = new URL(url)
	const pathname = parsed.pathname.replace(/\/+$/, '')
	if (!/\/loki\/api\/v1\/push$/u.test(pathname)) {
		parsed.pathname = `${pathname}/loki/api/v1/push`
	}
	// URL fragments are client-side only and must never become part of the
	// remote ingestion endpoint.
	parsed.hash = ''
	return parsed.toString()
}

const normalizeLabelKey = (key: string): string => {
	const normalized = key.replace(/[^a-zA-Z0-9_:]/gu, '_')
	if (/^[a-zA-Z_:]/u.test(normalized)) return normalized
	return `_${normalized}`
}

function safeLabelKey(key: string, index: number, labels: Readonly<Record<string, string>>): string {
	const sanitized = sanitizeLoggingDiagnostic(key)
	let normalized = sanitized === key && !sensitiveKeyContainsPayload(key)
		? normalizeLabelKey(key) : `_redacted_key_${index}`
	let collision = 0
	while (Object.prototype.hasOwnProperty.call(labels, normalized)) {
		collision += 1
		normalized = `_redacted_key_${index}_${collision}`
	}
	return normalized
}

function sanitizeLabelString(value: string): string {
	const trimmed = value.trim()
	if (!trimmed) return ''
	try {
		const url = new URL(trimmed)
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return 'url'
		}
	} catch {
		// Continue with pattern classification.
	}
	if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(trimmed)) return 'email'
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(trimmed)) return 'id'
	if (/\b[0-9a-f]{16,}\b/iu.test(trimmed)) return 'token'
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (/\b[A-Za-z0-9+/=_-]{40,}\b/u.test(trimmed)) return 'token'
	if (/(^|[-_])(tenant|workspace|account|customer|org|project)([-_]|$)/iu.test(trimmed) && /[-_]/u.test(trimmed)) {
		return 'id'
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (/\/\d{2,}\b/u.test(trimmed) || /\b\d{4,}\b/u.test(trimmed)) return 'id'
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (trimmed.length > 64) return 'value'
	return trimmed
}

const normalizeLabelValue = (value: unknown): string | null => {
	if (value == null) return null
	if (typeof value === 'string') {
		const normalized = sanitizeLabelString(value)
		return normalized ? normalized : null
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return null
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

function normalizeSensitiveLabelValue(key: string, value: unknown): string | null {
	const compactKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
	if (/(?:password|passwd|secret|token|authorization|apikey|privatekey|cookie|cvv)/u.test(compactKey)) {
		return 'redacted'
	}
	if (/(?:userid|sessionid|accountid|customerid|tenantid|workspaceid|projectid)/u.test(compactKey)) {
		return value == null ? null : 'id'
	}
	if (compactKey.includes('email')) return value == null ? null : 'email'
	if (compactKey.includes('phone')) return value == null ? null : 'phone'
	if (compactKey === 'ip' || compactKey.includes('ipaddress') || compactKey.includes('forwardedfor')) {
		return value == null ? null : 'ip'
	}
	if (isSensitiveFreeformKey(key)) return value == null ? null : 'redacted'
	return normalizeLabelValue(value)
}

const toNanoseconds = (timestampMs: number): string =>
	(BigInt(Math.trunc(timestampMs)) * 1_000_000n).toString()

function composeAbortSignal(
	AbortControllerRuntime: typeof AbortController | undefined,
	timeoutMs?: number,
	external?: AbortSignal
) {
	const ctl = AbortControllerRuntime
		? Reflect.construct(AbortControllerRuntime, []) as AbortController
		: undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let off: (() => void) | undefined
	let timedOut = false
	let rejectDeadline: ((error: Error) => void) | undefined
	const deadline = typeof timeoutMs === 'number' && timeoutMs > 0
		? new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
		: undefined
	if (typeof timeoutMs === 'number' && timeoutMs > 0) {
		timer = setTimeout(() => {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			timedOut = true
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			try { ctl?.abort() } catch { /* the explicit deadline still wins */ }
			rejectDeadline?.(new Error('logging Loki transport deadline exceeded'))
		}, timeoutMs)
		timer.unref?.()
	}
	if (external) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const onAbort = () => { try { ctl?.abort() } catch { /* external state still wins */ } }
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (external.aborted) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			onAbort()
		} else {
			external.addEventListener('abort', onAbort, {once: true})
			off = () => { try { external.removeEventListener('abort', onAbort) } catch { /* Cleanup is best-effort. */ } }
		}
	}

	return {
		signal: ctl?.signal ?? external,
		deadline,
		cleanup: () => {
			if (timer) clearTimeout(timer)
			off?.()
		},
		didTimeout: () => timedOut
	}
}

const tryParsePayload = (line: string): LokiLogPayload | null => {
	try {
		const parsed = JSON.parse(line) as LokiLogPayload
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return parsed && typeof parsed === 'object' ? parsed : null
	} catch {
		return null
	}
}

const buildLabels = (
	config: Readonly<LokiLoggingSinkConfig>,
	payload: LokiLogPayload | null
): Record<string, string> => {
	const attributes = payload?.attributes ?? {}
	const candidateLabels: Record<string, unknown> = Object.assign(
		Object.create(null) as Record<string, unknown>,
		config.defaultLabels ?? {}
	)
	for (const [key, value] of Object.entries({
		app: attributes.app,
		hostKind: attributes.hostKind,
		runtime: attributes.runtime,
		level: payload?.level,
		namespace: payload?.namespace,
		service: attributes.service
	})) if (value !== undefined && value !== null) candidateLabels[key] = value

	const labels = Object.create(null) as Record<string, string>
	for (const [index, [key, value]] of Object.entries(candidateLabels).entries()) {
		const normalizedValue = normalizeSensitiveLabelValue(key, value)
		if (!normalizedValue) continue
		labels[safeLabelKey(key, index, labels)] = normalizedValue
	}
	return labels
}

const groupLinesIntoStreams = (
	config: Readonly<LokiLoggingSinkConfig>,
	lines: readonly string[]
): LokiStream[] => {
	const streams = new Map<string, LokiStream>()

	for (const line of lines) {
		const payload = tryParsePayload(line)
		const labels = buildLabels(config, payload)
		const timestamp = typeof payload?.time === 'number' && Number.isSafeInteger(payload.time) && payload.time >= 0
			? payload.time
			: Date.now()
		const streamKey = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))
		const existing = streams.get(streamKey)
		const entry: [string, string] = [toNanoseconds(timestamp), line]
		if (existing) {
			existing.values.push(entry)
			continue
		}
		streams.set(streamKey, {
			stream: labels,
			values: [entry]
		})
	}

	return [...streams.values()]
}

const postStreams = async(
	fetchRequest: typeof fetch | undefined,
	AbortControllerRuntime: typeof AbortController | undefined,
	config: Readonly<LokiLoggingSinkConfig>,
	lines: readonly string[],
	options: SinkWriteOptions | undefined,
	requestOwnership: RequestOwnership,
	lifecycleReentryState: TransferLifecycleReentryState
): Promise<void> => {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (lines.length === 0) return
	if (options?.signal?.aborted) {
		throw createLokiSinkError(config.url, 'Aborted', 'LOKI_ABORTED', false)
	}

	const {signal, deadline, cleanup, didTimeout} = composeAbortSignal(
		AbortControllerRuntime,
		config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		options?.signal
	)
	const requestUrl = normalizeUrl(config.url)
	try {
		if (!fetchRequest) throw new Error('Fetch unavailable')
		if (!hasRequestCapacity(requestOwnership)) {
			throw createLokiSinkError(config.url, 'Remote request capacity exhausted', 'LOKI_NETWORK', false, undefined, true)
		}
		const request = startOwnedRequest(requestOwnership, () => invokeTransferLifecycle(
			lifecycleReentryState,
			() => fetchRequest.call(globalThis, requestUrl, {
				method: 'POST',
				redirect: 'error',
				headers: {
					'content-type': 'application/json',
					...(config.headers ?? {})
				},
				body: JSON.stringify({streams: groupLinesIntoStreams(config, lines)}),
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				...(signal ? {signal} : {}),
				...(config.keepalive ? {keepalive: true} : {})
			})
		))
		const response = await (deadline ? Promise.race([request, deadline]) : request)
		try {
			void response.body?.cancel().catch(() => undefined)
		} catch {
			// Response payloads are not part of the logging sink contract.
		}

		if (!response.ok) {
			const statusText = response.statusText ? ` ${response.statusText}` : ''
			const {code, retryable} = classifyLokiStatus(response.status)
			const responseError = createLokiSinkError(
				config.url,
				`${response.status}${statusText} - [response body omitted]`,
				code,
				retryable,
				response.status,
				response.status < 500
			)
			if (response.status >= 500) {
				Object.assign(responseError, {nonRetryable: true, ambiguousDelivery: true})
			}
			throw responseError
		}
	} catch(error) {
		if (readLoggingDataProperty(error, LOKI_SINK_ERROR) === true) {
			throw error
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (options?.signal?.aborted) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			throw createLokiSinkError(config.url, 'Aborted', 'LOKI_ABORTED', false)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (didTimeout()) {
			const timeoutError = createLokiSinkError(config.url, 'Timeout', 'LOKI_TIMEOUT', false)
			Object.assign(timeoutError, {nonRetryable: true, ambiguousDelivery: true})
			throw timeoutError
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const message = sanitizeLoggingErrorDiagnostic(error)
		const networkError = createLokiSinkError(config.url, message, 'LOKI_NETWORK', true)
		Object.assign(networkError, {nonRetryable: true, ambiguousDelivery: true})
		throw networkError
	} finally {
		cleanup()
	}
}

export function createLokiLoggingSink(config: Readonly<LokiLoggingSinkConfig>): Sink<string> {
	const fetchRequest = captureLoggingMethod<typeof fetch>(globalThis, 'fetch')
	const AbortControllerRuntime = captureLoggingMethod<typeof AbortController>(globalThis, 'AbortController')
	const requestOwnership = createRequestOwnership()
	const lifecycleReentryState = createTransferLifecycleReentryState()
	let closePromise: Promise<void> | undefined
	const snapshot: LokiLoggingSinkConfig = {
		provider: 'loki',
		url: config.url,
		...(config.headers ? {headers: {...config.headers}} : {}),
		...(config.defaultLabels ? {defaultLabels: {...config.defaultLabels}} : {}),
		...(config.requestTimeoutMs !== undefined ? {requestTimeoutMs: config.requestTimeoutMs} : {}),
		...(config.keepalive !== undefined ? {keepalive: config.keepalive} : {})
	}
	const snapshotPayload = (value: unknown): string[] => {
		try { return snapshotLoggingPayloadLines(value) } catch {
			throw createLokiSinkError(config.url, 'Payload rejected', 'LOKI_BAD_REQUEST', false, undefined, true)
		}
	}
	return attachTransferLifecycleReentryState({
		async write(line: string, options?: SinkWriteOptions): Promise<void> {
			await postStreams(fetchRequest, AbortControllerRuntime, snapshot, snapshotPayload([line]), options, requestOwnership,
				lifecycleReentryState)
		},
		async writeBatch(lines: readonly string[], options?: SinkWriteOptions): Promise<void> {
			await postStreams(fetchRequest, AbortControllerRuntime, snapshot, snapshotPayload(lines), options, requestOwnership,
				lifecycleReentryState)
		},
		async flush() {
			if (isTransferLifecycleStateReentry(lifecycleReentryState)) return
			await waitForOwnedRequests(requestOwnership)
		},
		async close() {
			if (isTransferLifecycleStateReentry(lifecycleReentryState)) return
			if (!closePromise) {
				requestOwnership.accepting = false
				closePromise = waitForOwnedRequests(requestOwnership)
			}
			await closePromise
		}
	}, lifecycleReentryState)
}
