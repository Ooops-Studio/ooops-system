import {wrapDeliveryError} from '../features/transferring/delivery'
import type {Sink, SinkWriteOptions} from '../types/sink'
import type {LogLine} from '../types/transferring'
import {captureLoggingMethod, inspectLoggingProperty, readLoggingDataProperty} from '../utils/capabilities'
import {sanitizeLoggingErrorDiagnostic} from '../utils/sanitize-diagnostic'

const normalizeExternalWriteFailure = (error: unknown, lines: readonly LogLine[]): unknown => {
	// A rejected external write does not establish whether the destination accepted
	// the record before the failure became observable. Require an explicit
	// knownNoDelivery acknowledgement before retry/fallback can safely replay it.
	const ambiguous = wrapDeliveryError(error, lines)
	ambiguous.name = 'Error'
	ambiguous.message = sanitizeLoggingErrorDiagnostic(error)
	delete ambiguous.cause
	if (typeof ambiguous.code !== 'string' || !/^[A-Z0-9_.:-]{1,128}$/iu.test(ambiguous.code)) {
		delete ambiguous.code
	}
	if (typeof ambiguous.retryable !== 'boolean') delete ambiguous.retryable
	if (typeof ambiguous.nonRetryable !== 'boolean') delete ambiguous.nonRetryable
	if (!Number.isSafeInteger(ambiguous.statusCode)
		|| (ambiguous.statusCode as number) < 100 || (ambiguous.statusCode as number) > 599) {
		delete ambiguous.statusCode
	}
	if (!Number.isSafeInteger(ambiguous.deliveredCount)
		|| (ambiguous.deliveredCount as number) < 0 || (ambiguous.deliveredCount as number) > lines.length) {
		delete ambiguous.deliveredCount
	}
	const deliveredCount = inspectLoggingProperty<unknown>(error, 'deliveredCount')
	const contradictsNoDelivery = deliveredCount.found && (
		!deliveredCount.safe || !Number.isSafeInteger(deliveredCount.value) || deliveredCount.value !== 0
	)
	const ambiguityMetadata = ['ambiguousDelivery', 'pendingAmbiguousDelivery'].map((key) =>
		inspectLoggingProperty<unknown>(error, key)
	)
	const hasAmbiguousMetadata = ambiguityMetadata.some((metadata) =>
		metadata.found && (!metadata.safe || metadata.value !== false)
	)
	if (!hasAmbiguousMetadata
		&& readLoggingDataProperty(error, 'knownNoDelivery') === true
		&& !contradictsNoDelivery) return ambiguous
	ambiguous.code ??= 'DELIVERY_WRITE_AMBIGUOUS'
	ambiguous.nonRetryable = true
	ambiguous.ambiguousDelivery = true
	return ambiguous
}

export function snapshotExternalLoggingSink(value: unknown): Sink<LogLine> {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
		throw new TypeError('External logging sink must be an object')
	}
	const sink = value as Sink<LogLine>
	const writeProperty = inspectLoggingProperty<unknown>(sink, 'write')
	const optionalProperties = ['writeBatch', 'flush', 'close'] as const
	if (!writeProperty.safe || typeof writeProperty.value !== 'function') {
		throw new TypeError('External logging sink write must be a function')
	}
	for (const name of optionalProperties) {
		const property = inspectLoggingProperty<unknown>(sink, name)
		if (property.found && (!property.safe || typeof property.value !== 'function')) {
			throw new TypeError(`External logging sink ${name} must be a function when provided`)
		}
	}
	const write = captureLoggingMethod<Sink<LogLine>['write']>(sink, 'write')
	const writeBatch = captureLoggingMethod<NonNullable<Sink<LogLine>['writeBatch']>>(sink, 'writeBatch')
	const flush = captureLoggingMethod<NonNullable<Sink<LogLine>['flush']>>(sink, 'flush')
	const close = captureLoggingMethod<NonNullable<Sink<LogLine>['close']>>(sink, 'close')
	if (!write) throw new TypeError('External logging sink write must be a function')
	const invokeWithSignal = async(
		invoke: () => void | Promise<void>,
		options?: SinkWriteOptions
	): Promise<void> => {
		const signal = options?.signal
		if (signal?.aborted) throw signal.reason
		// Once an external write has started, its promise is the only reliable
		// ownership signal. Returning early on abort would let flush/close finish
		// while an abort-ignoring sink still owns the physical delivery. The retry
		// layer supplies the signal and applies its bounded deadline while retaining
		// this promise as an ambiguous delivery when the sink does not settle.
		await Promise.resolve().then(invoke)
	}
	// The descriptor checks above distinguish absent optional methods from
	// malformed/accessor-backed capabilities without evaluating either.
	return {
		write: async(line, options) => {
			try {
				await invokeWithSignal(async() => await write.call(sink, line, options), options)
			} catch(error) {
				// The retry layer owns cancellation classification. For an ordinary
				// rejection, preserve physical-delivery uncertainty at this public boundary.
				if (options?.signal?.aborted) throw error
				throw normalizeExternalWriteFailure(error, [line])
			}
		},
		...(writeBatch ? {writeBatch: async(lines: readonly LogLine[], options?: SinkWriteOptions) => {
			try {
				await invokeWithSignal(async() => await writeBatch.call(sink, lines, options), options)
			} catch(error) {
				if (options?.signal?.aborted) throw error
				throw normalizeExternalWriteFailure(error, lines)
			}
		}} : {}),
		...(flush ? {flush: flush.bind(sink)} : {}),
		...(close ? {close: close.bind(sink)} : {})
	}
}
