/**
 * @file engines/transport/http.ts
 * HTTP sink: POST NDJSON to a URL.
 *
 * This is a low-level transport primitive. It may reject on delivery failure so
 * retry/fallback orchestration can react correctly. User-facing logging APIs are
 * responsible for swallowing and reporting transport errors.
 *
 * Node >=22.14.0 or browsers (global fetch available).
 */

import {
	attachTransferLifecycleReentryState,
	createTransferLifecycleReentryState,
	invokeTransferLifecycle,
	isTransferLifecycleStateReentry,
	type TransferLifecycleReentryState
} from '../../core/transfer-lifecycle-reentry'
import type {Sink, SinkWriteOptions} from '../../types/sink'
import {captureLoggingMethod, readLoggingDataProperty} from '../../utils/capabilities'
import {sanitizeLoggingDiagnostic, sanitizeLoggingErrorDiagnostic} from '../../utils/sanitize-diagnostic'
import {sanitizeUrlForDiagnostics} from '../../utils/sanitize-url'

import {snapshotLoggingPayloadLines} from './payload-limits'
import {
	createRequestOwnership,
	hasRequestCapacity,
	type RequestOwnership,
	startOwnedRequest,
	waitForOwnedRequests
} from './request-ownership'

export interface HttpSinkOptions {
	/** Extra headers to send with each request. */
	readonly headers?: Readonly<Record<string, string>>
	/** Per-request timeout in ms (default: 5000). */
	readonly timeoutMs?: number
	/** Use Fetch keepalive (best-effort; mostly a browser thing). */
	readonly keepalive?: boolean
}

export interface HttpSinkError extends Error {
	readonly code: 'HTTP_BAD_REQUEST' | 'HTTP_UNAUTHORIZED' | 'HTTP_NOT_FOUND' | 'HTTP_RATE_LIMITED' | 'HTTP_REQUEST_TIMEOUT' | 'HTTP_SERVER_ERROR' | 'HTTP_TIMEOUT' | 'HTTP_ABORTED' | 'HTTP_NETWORK'
	readonly retryable: boolean
	readonly statusCode?: number
	/** The remote HTTP server responded without accepting the request payload. */
	readonly knownNoDelivery?: boolean
	readonly nonRetryable?: boolean
	readonly ambiguousDelivery?: boolean
}

const HTTP_SINK_ERROR = Symbol('ooops.logging.http-sink-error')

/** Compose a signal that aborts on timeout and/or external signal. */
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
			rejectDeadline?.(new Error('logging HTTP transport deadline exceeded'))
		}, timeoutMs)
		timer.unref?.()
	}
	if (external) {
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

function createHttpSinkError(
	url: string,
	message: string,
	code: HttpSinkError['code'],
	retryable: boolean,
	statusCode?: number,
	knownNoDelivery = false
): HttpSinkError {
	const safeUrl = sanitizeUrlForDiagnostics(url)
	return Object.assign(new Error(`HTTP log delivery failed for ${safeUrl}: ${sanitizeLoggingDiagnostic(message)}`), {
		[HTTP_SINK_ERROR]: true as const,
		code,
		retryable,
		...(statusCode !== undefined ? {statusCode} : {}),
		...(knownNoDelivery ? {knownNoDelivery: true} : {})
	})
}

function classifyHttpStatus(
	statusCode: number
): {code: HttpSinkError['code']; retryable: boolean} {
	if (statusCode === 429) {
		return {code: 'HTTP_RATE_LIMITED', retryable: true}
	}
	if (statusCode === 408) {
		return {code: 'HTTP_REQUEST_TIMEOUT', retryable: true}
	}
	if (statusCode >= 500) {
		return {code: 'HTTP_SERVER_ERROR', retryable: true}
	}
	if (statusCode === 400) {
		return {code: 'HTTP_BAD_REQUEST', retryable: false}
	}
	if (statusCode === 401 || statusCode === 403) {
		return {code: 'HTTP_UNAUTHORIZED', retryable: false}
	}
	if (statusCode === 404) {
		return {code: 'HTTP_NOT_FOUND', retryable: false}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return {code: 'HTTP_BAD_REQUEST', retryable: false}
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

async function postNdjson(
	fetchRequest: typeof fetch | undefined,
	AbortControllerRuntime: typeof AbortController | undefined,
	url: string,
	body: string,
	headers: Readonly<Record<string, string>> | undefined,
	timeoutMs: number,
	keepalive: boolean,
	signal: AbortSignal | undefined,
	requestOwnership: RequestOwnership,
	lifecycleReentryState: TransferLifecycleReentryState
): Promise<void> {
	if (signal?.aborted) {
		throw createHttpSinkError(url, 'Aborted', 'HTTP_ABORTED', false)
	}
	const {signal: finalSignal, deadline, cleanup, didTimeout} = composeAbortSignal(
		AbortControllerRuntime, timeoutMs, signal
	)
	try {
		if (!fetchRequest) throw new Error('Fetch unavailable')
		if (!hasRequestCapacity(requestOwnership)) {
			throw createHttpSinkError(url, 'Remote request capacity exhausted', 'HTTP_NETWORK', false, undefined, true)
		}
		const request = startOwnedRequest(requestOwnership, () => invokeTransferLifecycle(
			lifecycleReentryState,
			() => fetchRequest.call(globalThis, url, {
				method: 'POST',
				redirect: 'error',
				body,
				headers: {'content-type': 'application/x-ndjson; charset=utf-8', ...(headers ?? {})},
				...(finalSignal ? {signal: finalSignal} : {}),
				...(keepalive ? {keepalive: true} : {}) // keepalive is browser-only; harmless in Node
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
			const {code, retryable} = classifyHttpStatus(response.status)
			const responseError = createHttpSinkError(
				url,
				`${response.status}${statusText} - [response body omitted]`,
				code,
				retryable,
				response.status,
				response.status < 500
			)
			// A server error is evidence that the request reached the remote, not
			// evidence that its payload was rejected. Preserve that ambiguity through
			// circuit/batch wrappers so retry cannot duplicate an accepted record.
			if (response.status >= 500) {
				Object.assign(responseError, {nonRetryable: true, ambiguousDelivery: true})
			}
			throw responseError
		}
	} catch(error) {
		if (readLoggingDataProperty(error, HTTP_SINK_ERROR) === true) {
			throw error
		}

		if (signal?.aborted) {
			throw createHttpSinkError(url, 'Aborted', 'HTTP_ABORTED', false)
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (didTimeout()) {
			const timeoutError = createHttpSinkError(url, 'Timeout', 'HTTP_TIMEOUT', false)
			Object.assign(timeoutError, {nonRetryable: true, ambiguousDelivery: true})
			throw timeoutError
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}

		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const message = sanitizeLoggingErrorDiagnostic(error)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (message === 'Aborted') {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			throw createHttpSinkError(url, 'Aborted', 'HTTP_ABORTED', false)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
		const networkError = createHttpSinkError(url, message, 'HTTP_NETWORK', true)
		// Fetch cannot distinguish a pre-connect failure from a connection loss
		// after the remote accepted the request. Retrying that uncertainty can
		// duplicate a record, especially after circuit wrappers add failed lines.
		Object.assign(networkError, {nonRetryable: true, ambiguousDelivery: true})
		throw networkError
	} finally {
		cleanup()
	}
}

export function httpSink(url: string, opts: HttpSinkOptions = {}): Sink<string> {
	const {headers: sourceHeaders, timeoutMs = 5000, keepalive = false} = opts
	const headers = sourceHeaders ? {...sourceHeaders} : undefined
	const fetchRequest = captureLoggingMethod<typeof fetch>(globalThis, 'fetch')
	const AbortControllerRuntime = captureLoggingMethod<typeof AbortController>(globalThis, 'AbortController')
	const requestOwnership = createRequestOwnership()
	const lifecycleReentryState = createTransferLifecycleReentryState()
	let closePromise: Promise<void> | undefined
	const snapshotPayload = (value: unknown): string[] => {
		try { return snapshotLoggingPayloadLines(value) } catch {
			throw createHttpSinkError(url, 'Payload rejected', 'HTTP_BAD_REQUEST', false, undefined, true)
		}
	}

	return attachTransferLifecycleReentryState({
		async write(line: string, options?: SinkWriteOptions): Promise<void> {
			const [snapshot = ''] = snapshotPayload([line])
			await postNdjson(fetchRequest, AbortControllerRuntime, url, snapshot + '\n', headers, timeoutMs, keepalive,
				options?.signal, requestOwnership, lifecycleReentryState)
		},

		async writeBatch(lines: readonly string[], options?: SinkWriteOptions): Promise<void> {
			const snapshot = snapshotPayload(lines)
			if (snapshot.length === 0) return
			await postNdjson(fetchRequest, AbortControllerRuntime, url, snapshot.join('\n') + '\n', headers, timeoutMs,
				keepalive, options?.signal, requestOwnership, lifecycleReentryState)
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
