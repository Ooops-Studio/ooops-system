/**
 * @file Enriching via dynamic providers (per-call context).
 * Each provider receives the current record and returns a partial context patch.
 * Providers run sequentially; failures are reported via onError and do not short-circuit.
 */

import type {LogAttributes, LogContext, LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import {MAX_ACTIVE_PROVIDER_OPERATIONS} from '../../constants'
import type {Enriching, EnrichingProvider} from '../../types/enriching'
import {captureLoggingMethod, inspectLoggingProperty} from '../../utils/capabilities'
import {copyLogAttributes, mergeContext} from '../../utils/enriching'
import {createStageOnError} from '../../utils/on-error'
import {sanitizeLoggingDiagnostic} from '../../utils/sanitize-diagnostic'

export const DYNAMIC_PROVIDER_TIMEOUT_MS = 1_000

function safeRead<T>(value: object | undefined, key: string): T | undefined {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!value) return undefined
	try {
		return (value as Record<string, T>)[key]
	} catch {
		return undefined
	}
}

function providerLabel(provider: EnrichingProvider, index: number): string {
	try {
		return provider.name ? sanitizeLoggingDiagnostic(provider.name) : `#${index}`
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return `#${index}`
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

function withContext(record: LogRecord, context: LogContext): LogRecord {
	try {
		return {...record, context}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			level: safeRead<LogRecord['level']>(record, 'level') ?? 'info',
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			time: safeRead<number>(record, 'time') ?? 0,
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			message: safeRead<string>(record, 'message') ?? '',
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			context
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
}

async function runProvider(
	provider: EnrichingProvider,
	record: Readonly<LogRecord>,
	activeOperations: Set<Promise<LogAttributes>>,
	invocationState: {synchronous: boolean}
): Promise<LogAttributes> {
	if (invocationState.synchronous) {
		throw new Error('logging enrichment provider synchronous re-entry rejected')
	}
	if (activeOperations.size >= MAX_ACTIVE_PROVIDER_OPERATIONS) {
		throw new Error('logging enrichment provider capacity exhausted')
	}
	// Reserve capacity before invoking any caller-controlled code. Providers and
	// thenables may synchronously re-enter this enricher before returning.
	const reservation = Promise.resolve({}) as Promise<LogAttributes>
	activeOperations.add(reservation)
	let result: unknown
	let operation: Promise<LogAttributes>
	try {
		invocationState.synchronous = true
		result = provider(record)
		const inspectedThen = inspectLoggingProperty<unknown>(result, 'then')
		if (!inspectedThen.safe) throw new TypeError('Logging enrichment provider returned an accessor-backed thenable')
		const then = captureLoggingMethod<(resolve: (value: unknown) => void, reject: (reason?: unknown) => void) => void>(result, 'then')
		if (typeof then !== 'function') return result as LogAttributes
		operation = new Promise<unknown>((resolve, reject) => {
			try { then.call(result, resolve, reject) } catch(error) { reject(error) }
		}) as Promise<LogAttributes>
	} finally {
		invocationState.synchronous = false
		activeOperations.delete(reservation)
	}
	activeOperations.add(operation)
	void operation.catch(() => {
		// The caller handles timely failures; this contains a rejection that
		// settles only after the deadline has already won the race.
	})
	void operation.finally(() => { activeOperations.delete(operation) }).catch(() => undefined)
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`logging enrichment provider timed out after ${DYNAMIC_PROVIDER_TIMEOUT_MS}ms`))
		}, DYNAMIC_PROVIDER_TIMEOUT_MS)
		timer.unref?.()
	})
	try {
		return await Promise.race([operation, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export const createDynamicProvidersEnriching = (
	providers: ReadonlyArray<EnrichingProvider>,
	errors?: Errors,
	_selfMetrics?: boolean,
	_metrics?: MetricsPort
): Enriching => {

	const onError = createStageOnError(errors, {stage: 'enriching', step: 'dynamic-providers'})
	if (!providers || providers.length === 0) return (record) => record
	const providerSnapshot = [...providers]
	const activeOperations = new Set<Promise<LogAttributes>>()
	const invocationState = {synchronous: false}

	return async(record) => {
		const originalContext = safeRead<LogContext>(record, 'context')
		let nextContext = originalContext ?? {}
		let currentRecord = record

		for (let i = 0; i < providerSnapshot.length; i++) {
			const p = providerSnapshot[i]
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (!p) continue
			try {
				const patch = await runProvider(p, currentRecord, activeOperations, invocationState)
				if (patch !== undefined && patch !== null && (typeof patch !== 'object' || Array.isArray(patch))) {
					throw new TypeError('Logging enrichment provider must return an attributes object')
				}
				const attributes = patch ? copyLogAttributes(patch) : undefined
				if (attributes && Object.keys(attributes).length) {
					nextContext = mergeContext(nextContext, {attributes})
					currentRecord = withContext(record, nextContext)
				}
			} catch(error) {
				const provider = providerLabel(p, i)
				onError(error, {provider})
				// Report self-metrics if enabled
			}
		}

		// Preserve identity if nothing changed
		if (nextContext === originalContext ||
			(!originalContext && !Object.keys(nextContext).length)) {
			return record
		}
		return currentRecord
	}
}
