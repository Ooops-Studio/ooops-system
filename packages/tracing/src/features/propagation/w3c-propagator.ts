/**
 * @file W3C propagator wrapper for tracing service.
 * Wraps engines propagation with baggage limits enforcement and error handling.
 */
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {ExtractResult} from '@ooopsstudio/core/ports/tracing'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'
import {
	encodeBaggage,
	injectW3C,
	extractW3C,
	decodeTraceParent,
	isValidTraceState
} from '@ooopsstudio/core/utils/tracing'

import {MAX_BAGGAGE_BYTES} from '../../constants'
import {snapshotDataFields} from '../../utils/capabilities'
import {createTracingOnError} from '../../utils/on-error'

import {applyBaggageLimits} from './baggage-limits'
import type {TracingPropagator} from './types'

const EXTRACTED_TRACING_HEADERS = new Set(['traceparent', 'tracestate', 'baggage'])
const MAX_TRACEPARENT_CHARACTERS = 512
const MAX_TRACESTATE_CHARACTERS = 512
/**
 * Options for creating a W3C propagator.
 */
export interface W3CPropagatorOptions {
	/** Optional error handler */
	errors?: Errors
}
/**
 * W3C propagator interface.
 */
export interface W3CPropagator extends TracingPropagator {
	readonly format: 'w3c'
	/**
	 * Inject trace context into a carrier (headers object).
	 * Applies baggage limits before injection.
	 */
	inject(
		carrier: Record<string, string>,
		context: SpanContext | undefined,
		baggage?: LogAttributes
	): void
	/**
	 * Extract trace context from a carrier (headers object).
	 * Applies baggage limits to extracted baggage.
	 */
	extract(carrier: Record<string, string>): ExtractResult
}
/**
 * Create a W3C propagator.
 */
export function createW3CPropagator(options: W3CPropagatorOptions = {}): W3CPropagator {
	let configured: Readonly<Record<string, unknown>>
	try { configured = snapshotDataFields(options, 1, 32, new Set(['errors'])) }
	catch { throw new TypeError('Tracing W3C propagator options must be a closed plain data object') }
	const errors = configured.errors as Errors | undefined
	const reportError = createTracingOnError(errors, {stage: 'tracing'})
	return {
		format: 'w3c',
		inject(carrier, context, baggage) {
			try {
				assertPlainCarrier(carrier)
				const injected: Record<string, string> = Object.create(null) as Record<string, string>
				// Apply baggage limits before injection
				let limitedBaggage: LogAttributes | undefined
				if (baggage) {
					const limited = applyBaggageLimits(baggage)
					if (Object.keys(limited).length > 0) limitedBaggage = limited
				}
				// W3C baggage is an independent propagation field and remains useful
				// even when no trace context is active.
				if (!context) {
					const baggageValue = limitedBaggage ? encodeBaggage(limitedBaggage) : ''
					if (baggageValue) injected.baggage = baggageValue
					clearTracingHeaders(carrier, Object.keys(injected).length > 0)
					installInjectedHeaders(carrier, injected)
					return
				}
				// Inject W3C headers
				injectW3C(injected, context, limitedBaggage)
				// Prepare and validate every new value before mutating the caller's
				// carrier. Invalid contexts must not destroy a previously usable header
				// set merely because injection was attempted.
				clearTracingHeaders(carrier, Object.keys(injected).length > 0)
				installInjectedHeaders(carrier, injected)
			/* v8 ignore next -- defensive branch not constructible through the public tracing API */
			} catch(error) {
				reportError(error, {operation: 'inject-headers'})
			}
		},
		extract(carrier) {
			try {
				assertPlainCarrier(carrier)
				// Normalize carrier keys to lowercase for case-insensitive header lookup
				// HTTP headers are case-insensitive, and frameworks may normalize them differently
				const normalizedCarrier: Record<string, string> = Object.create(null) as Record<string, string>
				const seenTracingHeaders = new Set<string>()
				let scanned = 0
				for (const key in carrier) {
					if (++scanned > 1_024) throw new Error('Tracing header carrier contains too many fields')
					if (key.length > 32) continue
					if (!Object.hasOwn(carrier, key)) continue
					const descriptor = Object.getOwnPropertyDescriptor(carrier, key)
					if (!descriptor?.enumerable) continue
					if (!('value' in descriptor)) throw new Error('Tracing header carrier contains accessor-backed fields')
					const value = descriptor.value
					if (typeof value !== 'string') continue
					const normalizedKey = key.toLowerCase()
					if (!EXTRACTED_TRACING_HEADERS.has(normalizedKey)) continue
					if (seenTracingHeaders.has(normalizedKey)) {
						reportError(new Error(`Conflicting duplicate tracing header: ${normalizedKey}`), {
							operation: 'extract-headers', reason: 'duplicate-header'
						})
						return {}
					}
					seenTracingHeaders.add(normalizedKey)
					const maxCharacters = normalizedKey === 'baggage'
						? MAX_BAGGAGE_BYTES : normalizedKey === 'traceparent'
							? MAX_TRACEPARENT_CHARACTERS : MAX_TRACESTATE_CHARACTERS
					if (value.length > maxCharacters) {
						const reason = normalizedKey === 'baggage' ? 'baggage-too-large'
							: normalizedKey === 'traceparent' ? 'invalid-traceparent' : 'invalid-tracestate'
						reportError(new Error('Tracing propagation header exceeds its character limit'), {
							operation: 'extract-headers', reason
						})
						continue
					}
					normalizedCarrier[normalizedKey] = value
				}
				const baggageHeader = normalizedCarrier['baggage']
				if (typeof baggageHeader === 'string' && (
					baggageHeader.length > MAX_BAGGAGE_BYTES || byteSize(baggageHeader) > MAX_BAGGAGE_BYTES
				)) {
					delete normalizedCarrier['baggage']
					reportError(new Error('Tracing baggage header exceeds the maximum byte size'), {
						operation: 'extract-headers', reason: 'baggage-too-large'
					})
				}
				// Validate traceparent header before extraction
				const traceparentHeader = normalizedCarrier['traceparent']
				if (traceparentHeader) {
					let invalidTraceparent = false
					const rejectTraceparent = (error: Error, reason: string): void => {
						reportError(error, {operation: 'extract-headers', reason})
						invalidTraceparent = true
					}
					if (traceparentHeader.length > MAX_TRACEPARENT_CHARACTERS || !decodeTraceParent(traceparentHeader)) {
						rejectTraceparent(new Error('Invalid W3C traceparent header'), 'invalid-traceparent')
					}
					if (invalidTraceparent) {
						delete normalizedCarrier['traceparent']
						delete normalizedCarrier['tracestate']
					}
				}
				const traceStateHeader = normalizedCarrier['tracestate']
				if (traceStateHeader !== undefined && (
					traceStateHeader.length > MAX_TRACESTATE_CHARACTERS || !isValidTraceState(traceStateHeader)
				)) {
					delete normalizedCarrier['tracestate']
					reportError(new Error('Invalid W3C tracestate header'), {
						operation: 'extract-headers', reason: 'invalid-tracestate'
					})
				}
				// Extract W3C headers using normalized carrier
				const result = extractW3C(normalizedCarrier)
				// Apply baggage limits to extracted baggage (always enforced)
				if (result.baggage && Object.keys(result.baggage).length > 0) {
					result.baggage = applyBaggageLimits(result.baggage)
				}
				return result
			} catch(error) {
				reportError(error, {operation: 'extract-headers'})
				return {}
			}
		}
	}
}

function assertPlainCarrier(carrier: unknown): asserts carrier is Record<string, string> {
	if (!isPlainObject(carrier)) {
		throw new TypeError('Tracing header carrier must be a plain data object')
	}
}

function clearTracingHeaders(carrier: Record<string, string>, willInstallHeaders: boolean): void {
	let scanned = 0
	const keysToDelete: string[] = []
	for (const key in carrier) {
		if (++scanned > 1_024) throw new Error('Tracing header carrier contains too many fields')
		if (key.length > 32) continue
		if (!Object.hasOwn(carrier, key)) continue
		if (!['traceparent', 'tracestate', 'baggage', 'x-trace-id'].includes(key.toLowerCase())) continue
		const descriptor = Object.getOwnPropertyDescriptor(carrier, key)
		if (!descriptor?.configurable) throw new Error('Tracing header carrier contains immutable tracing fields')
		keysToDelete.push(key)
	}
	// Every injected header is installed under its canonical lower-case name
	// after all stale case variants are removed, so a non-extensible carrier
	// cannot accept the replacement. Establish that before deleting anything.
	if (willInstallHeaders && !Object.isExtensible(carrier)) {
		throw new Error('Tracing header carrier is not extensible')
	}
	for (const key of keysToDelete) delete carrier[key]
}

function installInjectedHeaders(carrier: Record<string, string>, headers: Record<string, string>): void {
	for (const [key, value] of Object.entries(headers)) {
		Object.defineProperty(carrier, key, {
			value,
			enumerable: true,
			configurable: true,
			writable: true
		})
	}
}
