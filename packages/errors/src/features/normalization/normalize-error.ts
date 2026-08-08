/**
 * @file Error normalization with enrichment.
 */

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {NormalizedError} from '@ooopsstudio/core/contracts/errors'
import {getContext} from '@ooopsstudio/core/runtime/context'

import {DEFAULT_SEVERITY, DEFAULT_SOURCE, ERROR_CODE_UNKNOWN} from '../../constants'
import type {EnrichedError, ErrorCategory, ErrorSeverity} from '../../types/normalized-error'
import {captureErrorCapability} from '../../utils/capabilities'
import {generateErrorId} from '../../utils/error-id'
import {ERROR_CATEGORIES, SEVERITY_LEVELS} from '../../utils/error-values'
import {inferSeverity} from '../../utils/guards'
import {redactEnrichedError, sanitizeErrorDiagnostic} from '../../utils/redaction'

const MAX_NORMALIZED_MACHINE_STRING = 1_024
const MAX_NORMALIZED_FREEFORM_STRING = 65_536
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000

function boundedString(value: unknown, maximum: number): string | undefined {
	return typeof value === 'string' && value.length <= maximum ? value : undefined
}

/**
 * Options for error normalization
 */
export interface NormalizeErrorOptions {
	readonly clock: Clock
	readonly defaultSource?: string
	readonly generateId?: boolean
	readonly tracer?: {
		currentTraceId?(): string | undefined
	}
	readonly redact?: boolean
}

function safeEntries(value: unknown): Array<[string, unknown]> {
	if (!value || typeof value !== 'object') return []
	try {
		return Reflect.ownKeys(value).slice(0, 200).flatMap((key): Array<[string, unknown]> => {
			if (typeof key !== 'string' || key.length === 0 || key.length > 128) return []
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			return descriptor?.enumerable && 'value' in descriptor ? [[key, descriptor.value]] : []
		})
	} catch {
		return []
	}
}

function safeDataProperty(value: object, key: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch { return undefined }
}

function isNonArrayObject(value: unknown): value is Readonly<Record<string, unknown>> {
	if (!value || typeof value !== 'object') return false
	try { return !Array.isArray(value) } catch { return false }
}

function nativeErrorKind(value: object): string | undefined {
	try {
		let prototype: object | null = Object.getPrototypeOf(value)
		for (let depth = 0; prototype && depth < 4; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, 'name')
			if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
				&& /^(?:Error|[A-Za-z][A-Za-z0-9]*Error)$/u.test(descriptor.value)) return descriptor.value
			prototype = Object.getPrototypeOf(prototype)
		}
	} catch {
		// Hostile proxies are normalized without prototype-derived diagnostics.
	}
	return undefined
}

function descriptorNormalizedInput(value: unknown): NormalizedError {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
		let message: string
		try { message = String(value) } catch { message = '[REDACTED]' }
		if (message.length > MAX_NORMALIZED_FREEFORM_STRING) message = '[DROPPED_OVERSIZED]'
		return {kind: 'UnknownError', message}
	}
	const canonicalKind = safeDataProperty(value, 'kind')
	const ownName = safeDataProperty(value, 'name')
	const ownMessage = safeDataProperty(value, 'message')
	const stack = safeDataProperty(value, 'stack')
	const code = safeDataProperty(value, 'code')
	const cause = safeDataProperty(value, 'cause')
	const data = safeDataProperty(value, 'data')
	const kind = boundedString(canonicalKind, MAX_NORMALIZED_MACHINE_STRING)
		?? boundedString(ownName, MAX_NORMALIZED_MACHINE_STRING)
		?? boundedString(nativeErrorKind(value), MAX_NORMALIZED_MACHINE_STRING)
		?? 'UnknownError'
	const message = boundedString(ownMessage, MAX_NORMALIZED_FREEFORM_STRING)
		?? (typeof ownMessage === 'string' ? '[DROPPED_OVERSIZED]' : sanitizeErrorDiagnostic(value))
	const boundedStack = boundedString(stack, MAX_NORMALIZED_FREEFORM_STRING)
	const boundedCode = boundedString(code, MAX_NORMALIZED_MACHINE_STRING)
	return {
		kind,
		message,
		...(boundedStack ? {stack: boundedStack} : {}),
		...(boundedCode ? {code: boundedCode} : {}),
		...(cause !== undefined ? {cause} : {}),
		...(isNonArrayObject(data)
			? {data: data as Readonly<Record<string, unknown>>}
			: {})
	}
}

function safeTimestamp(clock: Clock): number {
	try {
		const now = captureErrorCapability(clock, 'now')
		const timestamp: unknown = now?.call(clock)
		if (typeof timestamp === 'number' && Number.isSafeInteger(timestamp)
			&& timestamp >= 0 && timestamp <= MAX_DATE_TIMESTAMP) return timestamp
	} catch {
		// Fall through to the system clock.
	}
	try {
		const timestamp = Date.now()
		return Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_DATE_TIMESTAMP ? timestamp : 0
	} catch {
		return 0
	}
}

/**
 * Normalize and enrich an error from unknown to EnrichedError
 * @param error - The error to normalize (unknown type)
 * @param options - Normalization options
 * @param context - Optional additional context
 * @returns Normalized and enriched error
 */
export function normalizeError(
	error: unknown,
	options: NormalizeErrorOptions,
	context?: Record<string, unknown>
): EnrichedError {

	// Normalize strictly through descriptors so hostile Error subclasses,
	// proxies, and error-like objects cannot execute property getters.
	const base = descriptorNormalizedInput(error)

	const contextEntries = safeEntries(context)
	const contextValues = new Map(contextEntries)
	const providedSeverity = contextValues.get('severity')
	const explicitSeverity = typeof providedSeverity === 'string' &&
		SEVERITY_LEVELS.includes(providedSeverity as ErrorSeverity)
		? providedSeverity as ErrorSeverity
		: undefined

	const providedCategory = contextValues.get('category')
	const explicitCategory = typeof providedCategory === 'string' &&
		ERROR_CATEGORIES.includes(providedCategory as ErrorCategory)
		? providedCategory as ErrorCategory
		: undefined

	const contextSource = contextValues.get('source')
	const providedSource = typeof contextSource === 'string'
		&& contextSource.length <= MAX_NORMALIZED_MACHINE_STRING && contextSource.trim().length > 0
		? contextSource
		: undefined

	// Infer severity from error type/code unless explicit context overrides it
	const severity: ErrorSeverity = explicitSeverity ?? (inferSeverity(base) || DEFAULT_SEVERITY)

	// Cross-service/context helpers are diagnostics. Their failure must never
	// prevent an application error from being normalized and reported.
	let runtimeContext: ReturnType<typeof getContext> | undefined
	try {
		runtimeContext = getContext()
	} catch {
		runtimeContext = undefined
	}

	let tracerTraceId: string | undefined
	try {
		const currentTraceId = captureErrorCapability(options.tracer, 'currentTraceId')
		tracerTraceId = currentTraceId?.call(options.tracer) as string | undefined
	} catch {
		tracerTraceId = undefined
	}
	const usableTracerTraceId = typeof tracerTraceId === 'string'
		&& tracerTraceId.length <= MAX_NORMALIZED_MACHINE_STRING
		&& tracerTraceId.trim().length > 0
		? tracerTraceId
		: undefined
	const traceId = usableTracerTraceId ?? runtimeContext?.traceId

	let id: string | undefined
	if (options.generateId) {
		try { id = generateErrorId() } catch { id = undefined }
	}

	// Merge context: combine base.data with provided context
	const filteredContextEntries = contextEntries.filter(([key]) =>
		key !== 'source' && key !== 'severity' && key !== 'category'
	)
	const mergedEntries = [
		...safeEntries(base.data),
		...filteredContextEntries
	]
	const hasRuntimeContext =
		runtimeContext?.spanId || runtimeContext?.tenantId || runtimeContext?.userId
	// Every accepted entry has a non-empty key, so Object.fromEntries cannot
	// produce an empty object when mergedEntries is non-empty.
	const finalContext = mergedEntries.length > 0 || hasRuntimeContext
		? {
			...Object.fromEntries(mergedEntries),
			...(runtimeContext?.spanId ? {spanId: runtimeContext.spanId} : {}),
			...(runtimeContext?.tenantId ? {tenantId: runtimeContext.tenantId} : {}),
			...(runtimeContext?.userId ? {userId: runtimeContext.userId} : {})
		} as Readonly<Record<string, unknown>>
		: undefined

	// Build enriched error with context fields
	const enriched: EnrichedError = {
		...base,
		severity,
		category: explicitCategory ?? 'UNKNOWN', // May be overridden by classification
		timestamp: safeTimestamp(options.clock),
		...(id ? {id} : {}),
		...(runtimeContext?.correlationId ? {correlationId: runtimeContext.correlationId} : {}),
		...(traceId ? {traceId} : {}),
		source: providedSource ?? options.defaultSource ?? DEFAULT_SOURCE,
		...(finalContext ? {context: finalContext} : {}),
		// Ensure code exists
		code: base.code ?? ERROR_CODE_UNKNOWN
	}

	return options.redact === false ? enriched : redactEnrichedError(enriched)
}
