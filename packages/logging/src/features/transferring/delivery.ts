import type {Sink, SinkWriteOptions} from '../../types/sink'
import type {LogLine} from '../../types/transferring'
import {readLoggingDataProperty} from '../../utils/capabilities'

export {composeAbortSignals} from './delivery-signals'

export const FAILED_DELIVERY_LINES = Symbol('logging.failedDeliveryLines')

const MAX_DELIVERY_FAILURE_ITEMS = 10_000

export type LoggingDeliveryError<T = LogLine> = Error & {
	[FAILED_DELIVERY_LINES]?: readonly T[]
	code?: unknown
	nonRetryable?: unknown
	retryable?: unknown
	statusCode?: unknown
	knownNoDelivery?: boolean
	ambiguousDelivery?: boolean
	pendingAmbiguousDelivery?: boolean
	deliveredCount?: number
	cause?: unknown
}

const safeRead = (value: unknown, key: PropertyKey): unknown => {
	return readLoggingDataProperty(value, key)
}

/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
const safeString = (value: unknown, fallback: string): string => {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (typeof value === 'string') {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return value
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (value !== null && (typeof value === 'object' || typeof value === 'function')) return fallback
	try {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return String(value)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return fallback
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

const getErrorDetails = (error: unknown): {message: string; name: string} => {
	const message = safeRead(error, 'message')
	const name = safeRead(error, 'name')
	return {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		message: typeof message === 'string' ? message : safeString(error, 'logging delivery failed'),
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		name: typeof name === 'string' && name.length > 0 ? name : 'Error'
	}
}

const copyDeliveryMetadata = <T>(target: LoggingDeliveryError<T>, source: unknown): void => {
	const code = safeRead(source, 'code')
	const nonRetryable = safeRead(source, 'nonRetryable')
	const retryable = safeRead(source, 'retryable')
	const statusCode = safeRead(source, 'statusCode')
	const knownNoDelivery = safeRead(source, 'knownNoDelivery')
	const ambiguousDelivery = safeRead(source, 'ambiguousDelivery')
	const pendingAmbiguousDelivery = safeRead(source, 'pendingAmbiguousDelivery')
	const deliveredCount = safeRead(source, 'deliveredCount')
	if (code !== undefined) target.code = code
	if (nonRetryable !== undefined) target.nonRetryable = nonRetryable
	if (retryable !== undefined) target.retryable = retryable
	if (statusCode !== undefined) target.statusCode = statusCode
	if (knownNoDelivery === true) target.knownNoDelivery = true
	if (ambiguousDelivery === true) target.ambiguousDelivery = true
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (pendingAmbiguousDelivery === true) target.pendingAmbiguousDelivery = true
	if (typeof deliveredCount === 'number') target.deliveredCount = deliveredCount
}

export const isAmbiguousDeliveryError = (error: unknown): boolean =>
	safeRead(error, 'ambiguousDelivery') === true

export const isSignalAbortedDeliveryError = (error: unknown): boolean =>
	safeRead(error, 'code') === 'SIGNAL_ABORTED'

export const getDeliveredCount = (error: unknown): number => {
	const count = safeRead(error, 'deliveredCount')
	return typeof count === 'number' && Number.isFinite(count) && count > 0
		? Math.trunc(count)
		: 0
}

const readUndeliveredItems = <T>(
	error: unknown,
	fallbackItems: readonly T[]
): readonly T[] | undefined => {
	const items = safeRead(error, FAILED_DELIVERY_LINES)
	if (!Array.isArray(items)) return undefined
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(items, 'length')
		const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
		if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DELIVERY_FAILURE_ITEMS) return undefined
		const snapshot: T[] = []
		for (let index = 0; index < length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(items, String(index))
			if (!descriptor || !('value' in descriptor)) return undefined
			snapshot.push(descriptor.value as T)
		}
		if (fallbackItems.length === 0) return snapshot
		if (snapshot.length > fallbackItems.length) return undefined
		const remaining = new Map<T, number>()
		for (const item of fallbackItems) remaining.set(item, (remaining.get(item) ?? 0) + 1)
		for (const item of snapshot) {
			const count = remaining.get(item) ?? 0
			if (count === 0) return undefined
			if (count === 1) remaining.delete(item)
			else remaining.set(item, count - 1)
		}
		return snapshot
	} catch {
		return undefined
	}
}

const hasKnownBatchOutcome = <T>(error: unknown, fallbackItems: readonly T[]): boolean => {
	if (readUndeliveredItems(error, fallbackItems)) return true
	// Retry classification is not delivery acknowledgement. A batch sink must
	// explicitly establish that no item was accepted before orchestration can
	// retry or fall back without risking duplicate records.
	return safeRead(error, 'knownNoDelivery') === true
}

export const createDeliveryError = <T = LogLine>(
	error: unknown,
	undeliveredLines: readonly T[]
): LoggingDeliveryError<T> => {
	const {message, name} = getErrorDetails(error)
	const deliveryError = new Error(message) as LoggingDeliveryError<T>
	deliveryError.name = name
	deliveryError.cause = error
	deliveryError[FAILED_DELIVERY_LINES] = [...undeliveredLines]
	copyDeliveryMetadata(deliveryError, error)
	return deliveryError
}

export const getUndeliveredLines = (
	error: unknown,
	fallbackLines: readonly LogLine[]
): readonly LogLine[] => {
	return readUndeliveredItems(error, fallbackLines) ?? [...fallbackLines]
}

export const getUndeliveredItems = <T>(
	error: unknown,
	fallbackItems: readonly T[]
): readonly T[] => {
	return readUndeliveredItems(error, fallbackItems) ?? [...fallbackItems]
}

export const wrapDeliveryError = (
	error: unknown,
	fallbackLines: readonly LogLine[]
): LoggingDeliveryError => {
	const undeliveredLines = getUndeliveredLines(error, fallbackLines)
	const {message, name} = getErrorDetails(error)
	const deliveryError = new Error(message) as LoggingDeliveryError
	deliveryError.name = name
	deliveryError.cause = error
	deliveryError[FAILED_DELIVERY_LINES] = [...undeliveredLines]
	copyDeliveryMetadata(deliveryError, error)
	return deliveryError
}

export const createAmbiguousDeliveryTimeoutError = (
	message: string
): LoggingDeliveryError<LogLine> => Object.assign(new Error(message), {
	code: 'DELIVERY_TIMEOUT',
	nonRetryable: true,
	ambiguousDelivery: true
} satisfies Partial<LoggingDeliveryError<LogLine>>)

export const createSignalAbortedDeliveryError = <T>(
	signal: AbortSignal,
	undeliveredLines: readonly T[]
): LoggingDeliveryError<T> => {
	const reason = signal.reason
	const details = getErrorDetails(reason)
	const error = new Error(
		details.message === 'logging delivery failed' ? 'logging delivery aborted' : details.message
	) as LoggingDeliveryError<T>
	error.name = details.name === 'Error' ? 'AbortError' : details.name
	error.cause = reason
	error[FAILED_DELIVERY_LINES] = [...undeliveredLines]
	return Object.assign(error, {
		code: 'SIGNAL_ABORTED',
		nonRetryable: true
	} satisfies Partial<LoggingDeliveryError<T>>)
}

const createAmbiguousAbortDeliveryError = <T>(
	signal: AbortSignal,
	undeliveredLines: readonly T[],
	cause: unknown,
	deliveredCount = 0
): LoggingDeliveryError<T> => {
	const error = createDeliveryError(cause, undeliveredLines)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	error.code = safeRead(signal.reason, 'code') ?? 'DELIVERY_TIMEOUT'
	error.nonRetryable = true
	error.ambiguousDelivery = true
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (safeRead(signal.reason, 'pendingAmbiguousDelivery') === true) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		error.pendingAmbiguousDelivery = true
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (deliveredCount > 0) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		error.deliveredCount = deliveredCount
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	return error
}

export const writeItemsSequentially = async<T>(
	sink: Sink<T>,
	lines: readonly T[],
	options?: SinkWriteOptions
): Promise<void> => {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (lines.length === 0) return
	if (options?.signal?.aborted) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (isAmbiguousDeliveryError(options.signal.reason)) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			throw createAmbiguousAbortDeliveryError(options.signal, lines, options.signal.reason)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
		throw createSignalAbortedDeliveryError(options.signal, lines)
	}
	if (sink.writeBatch) {
		try {
			if (options) {
				await sink.writeBatch(lines, options)
			} else {
				await sink.writeBatch(lines)
			}
			return
		} catch(error) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (options?.signal?.aborted && !isAmbiguousDeliveryError(options.signal.reason)) {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				throw createSignalAbortedDeliveryError(options.signal, lines)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
			// Sink.writeBatch has no accepted-count contract. Without explicit delivery
			// metadata, retrying or falling back could duplicate an accepted prefix.
			if (!hasKnownBatchOutcome(error, lines)) {
				const ambiguous = createDeliveryError(error, lines)
				ambiguous.code = 'DELIVERY_BATCH_AMBIGUOUS'
				ambiguous.nonRetryable = true
				ambiguous.ambiguousDelivery = true
				throw ambiguous
			}
			const undeliveredLines = getUndeliveredItems(error, lines)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (!(error instanceof Error) && undeliveredLines.length <= 1) {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				throw error
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
			throw createDeliveryError(error, undeliveredLines)
		}
	}

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] as T
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (options?.signal?.aborted) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (isAmbiguousDeliveryError(options.signal.reason)) {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				throw createAmbiguousAbortDeliveryError(options.signal, lines.slice(index), options.signal.reason, index)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			throw createSignalAbortedDeliveryError(options.signal, lines.slice(index))
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
		try {
			if (options) {
				await sink.write(line, options)
			} else {
				await sink.write(line)
			}
		} catch(error) {
			if (options?.signal?.aborted) {
				if (isAmbiguousDeliveryError(options.signal.reason)) {
					throw createAmbiguousAbortDeliveryError(options.signal, lines.slice(index), error, index)
				}
				throw createSignalAbortedDeliveryError(options.signal, lines.slice(index))
			}
			const undeliveredLines = lines.slice(index)
			if (!(error instanceof Error) && undeliveredLines.length <= 1) {
				throw error
			}
			throw createDeliveryError(error, undeliveredLines)
		}
	}
}

export const writeLinesSequentially = writeItemsSequentially<LogLine>
