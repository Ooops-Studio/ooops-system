import type {EnrichedError} from '../../types/normalized-error'
import {redactEnrichedError} from '../../utils/redaction'
import type {ErrorSink, SentryErrorSinkConfig} from '../types'

import {parseSentryDsn} from './sentry-dsn'
import {buildSentryEnvelope, createSentryEvent} from './sentry-event'
import {sanitizeSentryTags} from './sentry-sanitization'

const DEFAULT_TIMEOUT_MS = 5000
const MAX_ACTIVE_CAPTURES = 100
const SENTRY_CONFIG_KEYS = new Set(['dsn', 'environment', 'release', 'serverName', 'requestTimeoutMs', 'tags'])
const MAX_SENTRY_CONFIG_STRING_LENGTH = 4_096

function disposeResponseBody(response: Response | undefined): void {
	try {
		const disposal = response?.body?.cancel()
		void disposal?.catch(() => undefined)
	} catch {
		// A response body is an external transport resource. Cleanup is best-effort
		// and must never replace the sanitized delivery result.
	}
}

function validateSentryConfigShape(config: object): void {
	try {
		const prototype = Object.getPrototypeOf(config)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		for (const key of Reflect.ownKeys(config)) {
			if (typeof key !== 'string' || !SENTRY_CONFIG_KEYS.has(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(config, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
		}
	} catch {
		throw new Error('createSentryErrorSink: invalid configuration')
	}
}

function configDataProperty(config: object, key: PropertyKey): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(config, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch { return undefined }
}

function isArrayOrUninspectable(value: unknown): boolean {
	try { return Array.isArray(value) } catch { return true }
}

class SentryTransportError extends Error {
	readonly statusCode?: number
	readonly code: string

	constructor(message: string, code: string, statusCode?: number) {
		super(message)
		this.name = 'SentryTransportError'
		if (statusCode !== undefined) this.statusCode = statusCode
		this.code = code
	}
}

function isSentryTransportError(value: unknown): value is SentryTransportError {
	try { return value instanceof SentryTransportError } catch { return false }
}

export function createSentryErrorSink(config: Readonly<SentryErrorSinkConfig>): ErrorSink {
	if (!config || typeof config !== 'object') throw new Error('createSentryErrorSink: invalid configuration')
	validateSentryConfigShape(config)
	const dsn = configDataProperty(config, 'dsn')
	if (typeof dsn !== 'string') throw new Error('createSentryErrorSink: invalid configuration')
	const parsed = parseSentryDsn(dsn)
	const requestTimeoutMs = configDataProperty(config, 'requestTimeoutMs')
	if (requestTimeoutMs !== undefined &&
		(!Number.isSafeInteger(requestTimeoutMs) || (requestTimeoutMs as number) <= 0 || (requestTimeoutMs as number) > 60_000)) {
		throw new Error('createSentryErrorSink: requestTimeoutMs must be an integer between 1 and 60000')
	}
	const stringOption = (key: 'environment' | 'release' | 'serverName'): string | undefined => {
		const value = configDataProperty(config, key)
		if (value === undefined) return undefined
		if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SENTRY_CONFIG_STRING_LENGTH) {
			throw new Error(`createSentryErrorSink: ${key} must be a non-empty bounded string`)
		}
		return value
	}
	const tags = configDataProperty(config, 'tags')
	if (tags !== undefined && (!tags || typeof tags !== 'object' || isArrayOrUninspectable(tags))) {
		throw new Error('createSentryErrorSink: tags must be an object')
	}
	if (tags !== undefined) {
		try {
			const prototype = Object.getPrototypeOf(tags)
			if (prototype !== Object.prototype && prototype !== null) throw new Error()
		} catch { throw new Error('createSentryErrorSink: tags must be a plain object') }
	}
	const environment = stringOption('environment')
	const release = stringOption('release')
	const serverName = stringOption('serverName')
	const eventConfig = {
		...(environment ? {environment} : {}),
		...(release ? {release} : {}),
		...(serverName ? {serverName} : {}),
		...(tags
			? {tags: sanitizeSentryTags(tags as Readonly<Record<string, string>>)}
			: {})
	}
	const timeoutMs = typeof requestTimeoutMs === 'number' ? requestTimeoutMs : DEFAULT_TIMEOUT_MS
	const observedFetch = configDataProperty(globalThis, 'fetch')
	const fetchRequest = typeof observedFetch === 'function' ? observedFetch : undefined
	let AbortControllerRuntime: typeof AbortController | undefined
	try { AbortControllerRuntime = globalThis.AbortController } catch { /* handled by capture */ }
	let closed = false
	let closing = false
	let closePromise: Promise<void> | undefined
	let invokingFetch = false
	const activeCaptures = new Set<Promise<void>>()
	let snapshottingCallerPayload = false
	const physicalRequests = new Set<Promise<unknown>>()
	const send = async(error: EnrichedError): Promise<void> => {
		let controller: AbortController
		try {
			if (!AbortControllerRuntime) throw new Error()
			controller = Reflect.construct(AbortControllerRuntime, []) as AbortController
		} catch {
			throw new SentryTransportError('Sentry error sink network failure', 'SENTRY_NETWORK_ERROR')
		}
		let signal: AbortSignal
		try { signal = controller.signal } catch {
			throw new SentryTransportError('Sentry error sink network failure', 'SENTRY_NETWORK_ERROR')
		}
		const wasAborted = (): boolean => {
			try { return signal.aborted === true } catch { return false }
		}
		let timeout: ReturnType<typeof setTimeout> | undefined
		let timedOut = false
		const deadline = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				timedOut = true
				try { controller.abort() } catch { /* the explicit deadline still wins */ }
				reject(new SentryTransportError('Sentry error sink request timed out', 'SENTRY_REQUEST_TIMEOUT'))
			}, timeoutMs)
		})
		try { timeout?.unref?.() } catch { /* optional timer optimization */ }
		let response: Response | undefined
		try {
			const event = createSentryEvent(error, eventConfig)
			if (!fetchRequest) throw new Error()
			let fetchResult: unknown
			invokingFetch = true
			try {
				fetchResult = fetchRequest.call(globalThis, parsed.endpoint, {
					method: 'POST',
					redirect: 'error',
					headers: {
						'content-type': 'application/x-sentry-envelope',
						'x-sentry-auth': [
							'Sentry sentry_version=7',
							'sentry_client=@ooopsstudio/errors',
							`sentry_key=${parsed.publicKey}`,
							...(parsed.secretKey ? [`sentry_secret=${parsed.secretKey}`] : [])
						].join(', ')
					},
					body: buildSentryEnvelope(event, parsed),
					signal
				})
			} finally { invokingFetch = false }
			const request = Promise.resolve(fetchResult as Response | PromiseLike<Response>)
			physicalRequests.add(request)
			void request.then(
				(lateResponse) => { if (timedOut) disposeResponseBody(lateResponse) },
				() => undefined
			)
			void request.then(
				() => physicalRequests.delete(request),
				() => physicalRequests.delete(request)
			)
			response = await Promise.race([request, deadline])
			let observedOk: unknown
			let observedStatus: unknown
			try {
				observedOk = response.ok
				observedStatus = response.status
			} catch {
				throw new SentryTransportError(
					'Sentry error sink received an invalid response', 'SENTRY_RESPONSE_ERROR', 0
				)
			}
			const validStatus = typeof observedStatus === 'number' && Number.isSafeInteger(observedStatus)
				&& observedStatus >= 100 && observedStatus <= 599
			if (typeof observedOk !== 'boolean' || !validStatus) {
				throw new SentryTransportError(
					'Sentry error sink received an invalid response', 'SENTRY_RESPONSE_ERROR', 0
				)
			}
			if (!observedOk) {
				const statusCode = observedStatus as number
				throw new SentryTransportError(
					`Sentry error sink failed with status ${statusCode}`, 'SENTRY_RESPONSE_ERROR', statusCode
				)
			}
		} catch(error) {
			if (isSentryTransportError(error)) throw error
			if (wasAborted()) {
				throw new SentryTransportError('Sentry error sink request timed out', 'SENTRY_REQUEST_TIMEOUT')
			}
			throw new SentryTransportError('Sentry error sink network failure', 'SENTRY_NETWORK_ERROR')
		} finally {
			if (timeout !== undefined) {
				try { clearTimeout(timeout) } catch { /* preserve the sanitized transport result */ }
			}
			disposeResponseBody(response)
		}
	}
	const capture = (error: EnrichedError): Promise<void> => {
		if (closed || closing) {
			return Promise.reject(new SentryTransportError('Sentry error sink is closed', 'SENTRY_SINK_CLOSED'))
		}
		if (snapshottingCallerPayload || activeCaptures.size >= MAX_ACTIVE_CAPTURES
			|| physicalRequests.size >= MAX_ACTIVE_CAPTURES) {
			return Promise.reject(new SentryTransportError('Sentry error sink is overloaded', 'SENTRY_SINK_OVERLOADED'))
		}
		let releaseOwnership!: () => void
		const ownership = new Promise<void>((resolve) => { releaseOwnership = resolve })
		activeCaptures.add(ownership)
		const release = () => {
			activeCaptures.delete(ownership)
			releaseOwnership()
		}
		// Snapshot at admission, then defer external transport execution until the
		// operation is owned by activeCaptures. A synchronous fetch implementation
		// can re-enter capture(); invoking it before registration bypassed the cap.
		let publicError: EnrichedError
		try {
			snapshottingCallerPayload = true
			publicError = redactEnrichedError(error)
		} catch {
			release()
			return Promise.reject(new SentryTransportError('Sentry error sink payload failure', 'SENTRY_PAYLOAD_ERROR'))
		} finally {
			snapshottingCallerPayload = false
		}
		const operation = Promise.resolve().then(async() => await send(publicError))
		void operation.then(release, release)
		return operation
	}
	const drain = async(): Promise<void> => {
		const acceptedBeforeDrain = [...activeCaptures]
		if (acceptedBeforeDrain.length > 0) {
			await Promise.allSettled(acceptedBeforeDrain)
		}
	}
	return {
		capture,
		async flush() {
			if (invokingFetch) return
			await drain()
		},
		async close() {
			if (invokingFetch) return
			if (closed) return
			if (closePromise) return await closePromise
			closing = true
			const operation = drain().then(() => {
				closed = true
				closing = false
			})
			closePromise = operation
			try { await operation } finally { if (closePromise === operation) closePromise = undefined }
		}
	}
}
