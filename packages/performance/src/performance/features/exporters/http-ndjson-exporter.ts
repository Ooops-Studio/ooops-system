import type {PerformanceEventRecord} from '@ooopsstudio/core/contracts/performance'
import type {PerformanceEventExporterPort} from '@ooopsstudio/core/ports/performance'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import {
	MAX_PERFORMANCE_EXPORT_BATCH_BYTES,
	MAX_PERFORMANCE_EXPORT_BATCH_COUNT,
	serializePerformanceEventRecord
} from '../../core/event-export-utils'
import {classifyFetchFailure, classifyHttpStatus, createPerformanceExportError} from '../../core/export-errors'
import {
	hasSafeRuntimePrototype,
	ignoreRuntimePromiseRejection,
	isRuntimePromise,
	isRuntimeProxy
} from '../../utils/safe-object'

export interface HttpNdjsonPerformanceEventExporterOptions {
	url: string
	headers?: Record<string, string>
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

const RESERVED_HEADERS = new Set(['content-length', 'host', 'transfer-encoding'])
const MAX_HEADER_COUNT = 100
const MAX_HEADER_VALUE_BYTES = 8_192
const MAX_URL_LENGTH = 4_096
const MAX_HTTP_TIMEOUT_MS = 30_000

export function createHttpNdjsonPerformanceEventExporter(
	options: HttpNdjsonPerformanceEventExporterOptions
): PerformanceEventExporterPort {
	const configured = snapshotDataObject(
		options,
		new Set(['url', 'headers', 'fetchImpl', 'timeoutMs']),
		'Performance NDJSON exporter options'
	)
	const {url: rawUrl, headers: rawHeaders = {}, fetchImpl: rawFetch, timeoutMs: rawTimeout} = configured
	if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
		throw new Error(`Performance NDJSON exporter URL must be a non-empty string of at most ${MAX_URL_LENGTH} characters`)
	}
	let parsedUrl: URL
	try { parsedUrl = new URL(rawUrl) } catch { throw new Error('Performance NDJSON exporter URL must be a valid URL') }
	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new Error('Performance NDJSON exporter URL must use HTTP or HTTPS')
	}
	const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.+$/u, '')
	const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
		|| /^127(?:\.\d{1,3}){3}$/u.test(hostname)
	if (parsedUrl.protocol === 'http:' && !loopback) {
		throw new Error('Performance NDJSON exporter remote URLs must use HTTPS')
	}
	if (parsedUrl.username || parsedUrl.password) {
		throw new Error('Performance NDJSON exporter URL must not contain credentials; use headers instead')
	}
	if (parsedUrl.search || parsedUrl.hash) {
		throw new Error('Performance NDJSON exporter URL must not contain query parameters or fragments')
	}
	const timeoutMs = rawTimeout ?? 5_000
	if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs)
		|| timeoutMs <= 0 || timeoutMs > MAX_HTTP_TIMEOUT_MS) {
		throw new Error(`Performance NDJSON exporter timeoutMs must be between 1 and ${MAX_HTTP_TIMEOUT_MS}`)
	}

	const configuredFetch = rawFetch ?? globalThis.fetch
	if (typeof configuredFetch !== 'function') {
		throw new Error('Performance NDJSON exporter requires a fetch implementation')
	}
	const fetchImpl = configuredFetch as typeof fetch
	const url = parsedUrl.toString()
	const headers = Object.fromEntries(Object.entries(snapshotHeaders(rawHeaders))
		.filter(([name]) => name.toLowerCase() !== 'content-type'))
	type ActiveRequest = {
		body: string
		controller: AbortController
		promise: Promise<Response>
		invocation?: Promise<void>
		settled: 0 | 1 | 2 // pending | reusable success | failure
		timedOut: boolean
	}
	let activeRequest: ActiveRequest | undefined
	let pendingBodyDisposal: Promise<unknown> | undefined
	let bodyDisposalDisabled = false
	const disposeResponse = (response: Response | undefined): void => {
		if (pendingBodyDisposal || bodyDisposalDisabled) return
		const disposal = disposeResponseBody(response)
		if (!disposal) return
		pendingBodyDisposal = disposal
		let cleanupTimeout: ReturnType<typeof setTimeout> | undefined
		const release = () => {
			if (pendingBodyDisposal !== disposal) return
			pendingBodyDisposal = undefined
			if (cleanupTimeout !== undefined) {
				try { clearTimeout(cleanupTimeout) } catch { /* cleanup settlement remains authoritative */ }
				cleanupTimeout = undefined
			}
		}
		try {
			cleanupTimeout = setTimeout(() => {
				if (pendingBodyDisposal !== disposal) return
				bodyDisposalDisabled = true
				release()
			}, timeoutMs)
			try { cleanupTimeout.unref?.() } catch { /* optional process-lifetime optimization */ }
		} catch {
			bodyDisposalDisabled = true
			release()
		}
		try { void Reflect.apply(Promise.prototype.then, disposal, [release, release]) } catch { release() }
	}
	let exportInvocationActive = false

	const exportBatch = async(batch: ReadonlyArray<PerformanceEventRecord>): Promise<void> => {
		if (pendingBodyDisposal) {
			throw createPerformanceExportError('A performance response cleanup is still active', {
				retryable: true,
				code: 'fetch_aborted'
			})
		}
		let body: string
		try {
			if (!Array.isArray(batch)) throw new TypeError()
			const lengthDescriptor = Object.getOwnPropertyDescriptor(batch, 'length')
			const batchLength = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
			if (!Number.isSafeInteger(batchLength) || batchLength < 0 ||
					batchLength > MAX_PERFORMANCE_EXPORT_BATCH_COUNT) throw new TypeError()
			if (batchLength === 0) return
			const lines: string[] = []
			let serializedBytes = 0
			for (let index = 0; index < batchLength; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(batch, String(index))
				if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError()
				const snapshot = serializePerformanceEventRecord(descriptor.value as PerformanceEventRecord)
				if (!snapshot) throw new TypeError('Invalid performance event record')
				serializedBytes += snapshot.bytes + 1
				if (serializedBytes > MAX_PERFORMANCE_EXPORT_BATCH_BYTES) throw new TypeError()
				lines.push(snapshot.serialized)
			}
			body = `${lines.join('\n')}\n`
		} catch(error) {
			throw createPerformanceExportError('Performance event serialization failed', {
				retryable: false,
				code: 'event_serialization_failed',
				cause: error
			})
		}
		let slot = activeRequest
		// A transport may acknowledge AbortController asynchronously, after the
		// invocation timeout has already returned. Keep late successes reusable to
		// avoid duplicate delivery, but never spend a retry on a settled rejection.
		if (slot?.settled === 2) activeRequest = slot = undefined
		if (slot && slot.body !== body) {
			if (slot.settled) activeRequest = slot = undefined
			else {
				throw createPerformanceExportError('A previous performance export is still active', {
					retryable: true,
					code: 'fetch_aborted'
				})
			}
		}
		if (!slot) {
			const controller = new AbortController()
			const pending: ActiveRequest = {
				body,
				controller,
				promise: undefined as unknown as Promise<Response>,
				settled: 0,
				timedOut: false
			}
			const request = Promise.resolve().then(() => {
				const result = fetchImpl(url, {
					method: 'POST',
					headers: {
						...headers,
						'content-type': 'application/x-ndjson'
					},
					body,
					signal: controller.signal,
					// Collector headers can contain credentials. Never forward them to
					// a redirected destination chosen by the remote endpoint.
					redirect: 'error'
				})
				if (!isRuntimePromise(result)) {
					throw createPerformanceExportError('', {
						retryable: false, code: 'invalid_fetch_response'
					})
				}
				return result
			})
			pending.promise = request
			slot = pending
			activeRequest = pending
			void request.then(
				(lateResponse) => {
					pending.settled = pending.timedOut && !snapshotValidResponse(lateResponse)?.ok ? 2 : 1
					if (pending.timedOut) {
						disposeResponse(lateResponse)
					}
				},
				() => {
					pending.settled = 2
				}
			)
		}
		const ownedSlot = slot
		if (ownedSlot.invocation) {
			throw createPerformanceExportError('A performance export invocation is already active', {
				retryable: true,
				code: 'fetch_aborted'
			})
		}
		const invocation = (async() => {
			let rejectTimeout!: (error: unknown) => void
			const timeoutFailure = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
			const timeout = setTimeout(() => {
				if (!ownedSlot.timedOut) {
					ownedSlot.timedOut = true
					try { ignoreRuntimePromiseRejection(ownedSlot.controller.abort()) } catch { /* timeout remains authoritative */ }
				}
				rejectTimeout(createPerformanceExportError('Performance NDJSON export timed out', {
					retryable: true,
					code: 'fetch_aborted'
				}))
			}, timeoutMs)
			let response: Response | undefined
			try {
				const fetchedResponse = await Promise.race([ownedSlot.promise, timeoutFailure])
				if (activeRequest === ownedSlot) activeRequest = undefined
				response = fetchedResponse
				const responseSnapshot = snapshotValidResponse(fetchedResponse)
				if (!responseSnapshot) {
					throw createPerformanceExportError('Performance NDJSON exporter received an invalid response', {
						retryable: false, code: 'invalid_fetch_response'
					})
				}
				const {ok, status} = responseSnapshot
				if (!ok) {
					const statusCode = status as number
					const classification = classifyHttpStatus(statusCode)
					throw createPerformanceExportError(
						`NDJSON performance export failed with status ${statusCode}`,
						{
							statusCode,
							...classification
						}
					)
				}
			} catch(error) {
				if (ownedSlot.settled && activeRequest === ownedSlot) activeRequest = undefined
				throw classifyFetchFailure(error)
			} finally {
				try { clearTimeout(timeout) } catch { /* response disposal remains authoritative */ }
				disposeResponse(response)
			}
		})()
		ownedSlot.invocation = invocation
		try {
			await invocation
		} finally {
			if (ownedSlot.invocation === invocation) ownedSlot.invocation = undefined
		}
	}
	return {
		export(batch) {
			if (exportInvocationActive) {
				return Promise.reject(createPerformanceExportError('A performance export invocation is already active', {
					retryable: true,
					code: 'fetch_aborted'
				}))
			}
			exportInvocationActive = true
			const operation = exportBatch(batch)
			const release = () => { exportInvocationActive = false }
			try { void Reflect.apply(Promise.prototype.then, operation, [release, release]) } catch { release() }
			return operation
		}
	}
}

function disposeResponseBody(response: Response | undefined): Promise<unknown> | undefined {
	try {
		if (!response || isRuntimeProxy(response)) return
		const body = readResponseProperty(response, 'body')
		if (!body || (typeof body !== 'object' && typeof body !== 'function') || isRuntimeProxy(body)) return
		let owner: object | null = body
		let cancel: ((...args: never[]) => unknown) | undefined
		for (let depth = 0; owner && depth < 8; depth += 1) {
			if (isRuntimeProxy(owner)) return
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'cancel')
			if (descriptor) {
				if ('value' in descriptor && typeof descriptor.value === 'function') cancel = descriptor.value
				break
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
		const disposal = cancel ? Reflect.apply(cancel, body, []) : undefined
		return isRuntimePromise(disposal) ? disposal as Promise<unknown> : undefined
	} catch { /* response disposal is best-effort */ }
}

function readResponseProperty(response: object, key: 'ok' | 'status' | 'body'): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(response, key)
	if (descriptor) return 'value' in descriptor ? descriptor.value : undefined
	if (typeof Response === 'undefined' || !hasSafeRuntimePrototype(response, Response.prototype)) return undefined
	const getter = Object.getOwnPropertyDescriptor(Response.prototype, key)?.get
	return typeof getter === 'function' ? Reflect.apply(getter, response, []) : undefined
}

function snapshotValidResponse(value: unknown): {ok: boolean; status: number} | undefined {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value)) return undefined
	try {
		const ok = readResponseProperty(value, 'ok')
		const status = readResponseProperty(value, 'status')
		if (typeof ok !== 'boolean' || !Number.isInteger(status)
			|| (status as number) < 100 || (status as number) > 599) return undefined
		const validStatus = status as number
		return ok === (validStatus >= 200 && validStatus < 300) ? {ok, status: validStatus} : undefined
	} catch { return undefined }
}

function snapshotHeaders(value: unknown): Readonly<Record<string, string>> {
	const headers = snapshotDataObject(value, undefined, 'Performance NDJSON exporter headers')
	if (Object.keys(headers).length > MAX_HEADER_COUNT) {
		throw new Error(`Performance NDJSON exporter headers must contain at most ${MAX_HEADER_COUNT} values`)
	}
	const snapshot: Record<string, string> = Object.create(null) as Record<string, string>
	const normalizedNames = new Set<string>()
	for (const [name, headerValue] of Object.entries(headers)) {
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/u.test(name)) {
			throw new Error('Performance NDJSON exporter header names must be valid HTTP tokens')
		}
		if (typeof headerValue !== 'string') {
			throw new Error(`Header value for "${name}" must be a string`)
		}
		if (headerValue.length > MAX_HEADER_VALUE_BYTES || byteSize(headerValue) > MAX_HEADER_VALUE_BYTES || /[\0\r\n]/u.test(headerValue)) {
			throw new Error(`Performance NDJSON exporter header value for "${name}" is invalid`)
		}
		if (RESERVED_HEADERS.has(name.toLowerCase())) {
			throw new Error(`Performance NDJSON exporter header "${name}" is managed by the HTTP transport`)
		}
		const normalizedName = name.toLowerCase()
		if (normalizedNames.has(normalizedName)) {
			throw new Error(`Performance NDJSON exporter header "${name}" is duplicated case-insensitively`)
		}
		normalizedNames.add(normalizedName)
		snapshot[name] = headerValue
	}
	return Object.freeze(snapshot)
}

function snapshotDataObject(
	value: unknown,
	allowed: ReadonlySet<string> | undefined,
	label: string
): Readonly<Record<string, unknown>> {
	try {
		if (!value || typeof value !== 'object' || isRuntimeProxy(value) || Array.isArray(value)) throw new TypeError()
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError()
		const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		let inspected = 0
		const maximum = allowed?.size ?? MAX_HEADER_COUNT
		for (const key in value) {
			if (inspected >= maximum) throw new TypeError()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (key.length > (allowed ? 64 : 256) || !descriptor?.enumerable || !('value' in descriptor)
				|| (allowed && !allowed.has(key))) throw new TypeError()
			inspected += 1
			snapshot[key] = descriptor.value
		}
		return Object.freeze(snapshot)
	} catch { throw new TypeError(`${label} must be a closed plain data object`) }
}
