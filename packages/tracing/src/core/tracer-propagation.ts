import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext, TracingContext} from '@ooopsstudio/core/contracts/tracing'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {ExtractResult, InjectOptions} from '@ooopsstudio/core/ports/tracing'
import type {AsyncContextStore} from '@ooopsstudio/core/runtime/context'

import {MAX_BAGGAGE_BYTES} from '../constants'
import {applyBaggageLimits} from '../features/propagation/baggage-limits'
import {createW3CPropagator} from '../features/propagation/w3c-propagator'
import {createTracingOnError} from '../utils/on-error'

interface TracerPropagationOptions {
	contextStore: AsyncContextStore<TracingContext | SpanContext | undefined>
	getActiveContext(): TracingContext | undefined
	markContextOwned(context: TracingContext): void
	errors?: Errors
	redactAttributes?: (attrs: LogAttributes) => LogAttributes
}

export function createTracerPropagation(options: TracerPropagationOptions) {
	const {contextStore, getActiveContext, markContextOwned, errors, redactAttributes} = options
	const propagator = createW3CPropagator({...(errors ? {errors} : {})})
	const reportError = createTracingOnError(errors, {stage: 'tracing'})
	const extractHeaders = (carrier: Record<string, string>): ExtractResult => {
		const result = propagator.extract(carrier)
		if (redactAttributes && result.baggage && Object.keys(result.baggage).length > 0) {
			try {
				result.baggage = applyBaggageLimits(redactAttributes(result.baggage))
			} catch(error) {
				reportError(error, {operation: 'redact-extracted-baggage'})
				delete result.baggage
			}
		}
		return result
	}
	return {
		injectHeaders: (carrier: Record<string, string>, injectOptions?: InjectOptions): void => {
			const context = getActiveContext()
			let baggage: LogAttributes = {}
			try {
				const activeBaggage = prepareBaggage(context?.baggage ?? {})
				const suppliedBaggage = readDataField(injectOptions, 'baggage')
				baggage = applyBaggageLimits({
					...activeBaggage,
					...prepareBaggage(suppliedBaggage ?? {})
				})
			} catch(error) {
				reportError(error, {operation: 'prepare-baggage'})
			}
			/* v8 ignore next -- defensive branch not constructible through the public tracing API */
			if (redactAttributes && Object.keys(baggage).length > 0) {
				try {
					baggage = applyBaggageLimits(redactAttributes(baggage))
				} catch(error) {
					reportError(error, {operation: 'redact-baggage'})
					baggage = {}
				}
			}
			propagator.inject(carrier, context?.spanContext, Object.keys(baggage).length > 0 ? baggage : undefined)
		},
		extractHeaders,
		withExtractedHeaders: async <T>(
			carrier: Record<string, string>,
			fn: () => T | Promise<T>
		): Promise<T> => {
			let result: ExtractResult = {}
			try { result = extractHeaders(carrier) } catch(error) {
				reportError(error, {operation: 'prepare-header-extraction'})
			}
			let baggage: LogAttributes | undefined
			try {
				// Header extraction always defines a propagation boundary. Baggage is
				// independent from traceparent, so an omitted or rejected baggage header
				// must remain absent rather than inherit ambient request metadata.
				baggage = result.baggage ? {...result.baggage} : undefined
			} catch(error) {
				reportError(error, {operation: 'inherit-extracted-baggage'})
			}
			const extractedContext: TracingContext = {
				...(result.context ? {spanContext: result.context} : {}),
				/* v8 ignore next -- defensive branch not constructible through the public tracing API */
				...(baggage ? {baggage} : {})
			}
			markContextOwned(extractedContext)
			return contextStore.run(extractedContext, fn)
		},
		getBaggage: (): Readonly<LogAttributes> => {
			try { return applyBaggageLimits(getActiveContext()?.baggage ?? {}) } catch(error) {
				reportError(error, {operation: 'get-baggage'})
				return {}
			}
		},
		setBaggage: (attrs: LogAttributes, mode: 'merge' | 'replace' = 'merge'): void => {
			const active = getActiveContext()
			if (!active) return
			try {
				if (mode !== 'merge' && mode !== 'replace') throw new Error('Invalid baggage mode')
				const supplied = prepareBaggage(attrs)
				const existing = mode === 'replace' ? {} : prepareBaggage(active.baggage ?? {})
				let baggage = applyBaggageLimits({...existing, ...supplied})
				if (redactAttributes && Object.keys(baggage).length > 0) baggage = applyBaggageLimits(redactAttributes(baggage))
				active.baggage = baggage
			} catch(error) { reportError(error, {operation: 'set-baggage'}) }
		},
		clearBaggage: (keys?: readonly string[]): void => {
			const active = getActiveContext()
			if (!active?.baggage) return
			let baggage: Record<string, LogAttributes[string]>
			try {
				if (keys === undefined) {
					delete active.baggage
					return
				}
				baggage = applyBaggageLimits(active.baggage)
				for (const key of snapshotStringArray(keys)) delete baggage[key]
			} catch(error) {
				reportError(error, {operation: 'clear-baggage'})
				return
			}
			if (Object.keys(baggage).length === 0) delete active.baggage
			else active.baggage = baggage
		}
	}
}

function readDataField(value: unknown, key: PropertyKey): unknown {
	if (!value || typeof value !== 'object') return undefined
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	if (!descriptor) return undefined
	if (!('value' in descriptor)) throw new TypeError('Tracing propagation options must use data fields')
	return descriptor.value
}

function prepareBaggage(value: unknown): LogAttributes {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Tracing baggage must be a data object')
	return applyBaggageLimits(value as LogAttributes)
}

function snapshotStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) throw new TypeError('Tracing baggage keys must be an array')
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) throw new TypeError('Tracing baggage keys are invalid')
	const result: string[] = []
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
		if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' ||
			descriptor.value.length > MAX_BAGGAGE_BYTES) {
			throw new TypeError('Tracing baggage keys must contain strings')
		}
		result.push(descriptor.value)
	}
	return result
}
