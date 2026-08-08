/**
 * @file OTLP (OpenTelemetry Protocol) span exporter core.
 * Serializes spans to OTLP/JSON format for export to collectors.
 * No retry/rate limiting here (that's service layer).
 */

import type {SpanRecord} from '../../contracts/tracing'
import {byteSize} from '../../utils/byte-size'
import {isProxyObject} from '../../utils/safe-object'
import {isValidTraceState} from '../../utils/tracing/propagation'
import {containNativePromiseUnchecked} from '../async/native-promise'
import {
	addNativeWeakSet,
	deleteNativeWeakSet,
	getNativeMap,
	getNativeWeakMap,
	hasNativeWeakSet,
	pushNativeArray,
	setNativeMap,
	setNativeWeakMap,
	snapshotNativeMapValues
} from '../collections/native-collections'

const MAX_OTLP_ATTRIBUTE_ENTRIES = 10_000
const MAX_OTLP_ATTRIBUTE_NODES = 100_000
const MAX_OTLP_ATTRIBUTE_CHARACTERS = 16 * 1_024 * 1_024
const MAX_OTLP_BATCH_SNAPSHOT_NODES = 500_000
const MAX_OTLP_ATTRIBUTE_STRING = 1_048_576
const MAX_OTLP_SPANS = 10_000
const MAX_OTLP_JSON_BYTES = 16 * 1_024 * 1_024
const OTLP_JSON_ENTRY_OVERHEAD_BYTES = 256
const MAX_OTLP_SNAPSHOT_DEPTH = 12
const MAX_OTLP_TIMESTAMP_MS = 18_446_744_073_709
const MAX_OTLP_DROPPED_COUNT = 0xffff_ffff
const nativeObjectCreate = Object.create
const nativeObjectFreeze = Object.freeze
const INVALID_SNAPSHOT_PROTOTYPE = nativeObjectFreeze(nativeObjectCreate(null) as object)
const nativeJsonStringify = JSON.stringify.bind(JSON)
const nativeReflectApply = Reflect.apply
const nativeReflectOwnKeys = Reflect.ownKeys
const nativeMathFloor = Math.floor
const nativeMathTrunc = Math.trunc
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsInteger = Number.isInteger
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeNumberToString = Number.prototype.toString
const nativeBigIntToString = BigInt.prototype.toString
const NativeBigInt = BigInt
const nativeRegExpTest = RegExp.prototype.test
const nativeStringCharCodeAt = String.prototype.charCodeAt
const nativeArrayIncludes = Array.prototype.includes
const nativeArrayJoin = Array.prototype.join
const nativeArraySort = Array.prototype.sort
const nativeArrayIsArray = Array.isArray
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectPrototype = Object.prototype
const NativeMap = Map
const NativeWeakMap = WeakMap
const NativeWeakSet = WeakSet
const LOWER_HEX = /^[0-9a-f]+$/u
const VALID_TRACE_ID = /^[0-9a-f]{32}$/u
const ZERO_TRACE_ID = /^0{32}$/u
const VALID_SPAN_ID = /^[0-9a-f]{16}$/u
const ZERO_SPAN_ID = /^0{16}$/u

function matches(pattern: RegExp, value: string): boolean {
	return nativeReflectApply(nativeRegExpTest, pattern, [value]) as boolean
}

interface OtlpAttributeBudget {
	nodes: number
	characters: number
}

function createAttributeBudget(): OtlpAttributeBudget {
	return {nodes: MAX_OTLP_ATTRIBUTE_NODES, characters: MAX_OTLP_ATTRIBUTE_CHARACTERS}
}

function createBatchSnapshotBudget(): OtlpAttributeBudget {
	return {nodes: MAX_OTLP_BATCH_SNAPSHOT_NODES, characters: MAX_OTLP_JSON_BYTES}
}

function snapshotSpanInput(value: unknown, aggregateBudget?: OtlpAttributeBudget): SpanRecord {
	const budget = createAttributeBudget()
	const active = new NativeWeakSet<object>()
	const copies = new NativeWeakMap<object, unknown>()
	const consumeNode = (): void => {
		if (budget.nodes-- <= 0 || (aggregateBudget && aggregateBudget.nodes-- <= 0)
			|| budget.characters < 0 || (aggregateBudget && aggregateBudget.characters < 0)) {
			throw new Error('Invalid span: snapshot budget exceeded')
		}
	}
	const consumeCharacters = (count: number): void => {
		budget.characters -= count
		if (aggregateBudget) aggregateBudget.characters -= count
		if (budget.characters < 0 || (aggregateBudget && aggregateBudget.characters < 0)) {
			throw new Error('Invalid span: snapshot character limit exceeded')
		}
	}
	const inspectObject = (candidate: unknown, depth: number, label: string): object => {
		containNativePromiseUnchecked(candidate)
		consumeNode()
		if (!candidate || typeof candidate !== 'object') {
			throw new Error(`Invalid span: ${label} must be a plain data object`)
		}
		if (isProxyObject(candidate)) throw new Error('Invalid span: Proxy data is not supported')
		if (depth > MAX_OTLP_SNAPSHOT_DEPTH) throw new Error('Invalid span: snapshot nesting limit exceeded')
		let prototype: object | null
		try { prototype = nativeObjectGetPrototypeOf(candidate) as object | null } catch {
			throw new Error('Invalid span: record cannot be inspected safely')
		}
		if (prototype !== nativeObjectPrototype && prototype !== null) {
			throw new Error(`Invalid span: ${label} must be a plain data object`)
		}
		if (hasNativeWeakSet(active, candidate)) throw new Error('Invalid span: circular data graph')
		return candidate
	}
	const snapshotGraph = (candidate: unknown, depth: number): unknown => {
		containNativePromiseUnchecked(candidate)
		consumeNode()
		if (typeof candidate === 'string') {
			if (candidate.length > MAX_OTLP_ATTRIBUTE_STRING || candidate.length > budget.characters
				|| aggregateBudget && candidate.length > aggregateBudget.characters) {
				throw new Error('Invalid span: snapshot string limit exceeded')
			}
			consumeCharacters(candidate.length)
			return candidate
		}
		if (candidate === null || typeof candidate !== 'object') return candidate
		if (isProxyObject(candidate)) throw new Error('Invalid span: Proxy data is not supported')
		if (depth > MAX_OTLP_SNAPSHOT_DEPTH) throw new Error('Invalid span: snapshot nesting limit exceeded')
		if (hasNativeWeakSet(active, candidate)) throw new Error('Invalid span: circular data graph')
		const existing = getNativeWeakMap(copies, candidate)
		if (existing !== undefined) return existing

		let array: boolean
		let prototype: object | null
		try {
			array = nativeArrayIsArray(candidate)
			prototype = nativeObjectGetPrototypeOf(candidate) as object | null
		} catch { throw new Error('Invalid span: record cannot be inspected safely') }
		if (!array && prototype !== nativeObjectPrototype && prototype !== null) {
			return nativeObjectFreeze(nativeObjectCreate(INVALID_SNAPSHOT_PROTOTYPE) as object)
		}

		addNativeWeakSet(active, candidate)
		try {
			if (array) {
				const length = nativeObjectGetOwnPropertyDescriptor(candidate, 'length')?.value as unknown
				if (!nativeNumberIsSafeInteger(length) || (length as number) < 0
					|| (length as number) > MAX_OTLP_ATTRIBUTE_ENTRIES) {
					throw new Error(`Invalid span: arrays must contain at most ${MAX_OTLP_ATTRIBUTE_ENTRIES} entries`)
				}
				const result: unknown[] = []
				setNativeWeakMap(copies, candidate, result)
				for (let index = 0; index < (length as number); index += 1) {
					const descriptor = nativeObjectGetOwnPropertyDescriptor(candidate, index)
					if (!descriptor?.enumerable || !('value' in descriptor)) {
						throw new Error('Invalid span: arrays must be dense data arrays')
					}
					pushNativeArray(result, snapshotGraph(descriptor.value, depth + 1))
				}
				return result
			}

			const result = nativeObjectCreate(null) as Record<string, unknown>
			setNativeWeakMap(copies, candidate, result)
			let entries = 0
			let scanned = 0
			for (const key in candidate) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(candidate, key)
				if (!descriptor) break
				if (++scanned > MAX_OTLP_ATTRIBUTE_ENTRIES) {
					throw new Error(`Invalid span: objects must scan at most ${MAX_OTLP_ATTRIBUTE_ENTRIES} keys`)
				}
				if (++entries > MAX_OTLP_ATTRIBUTE_ENTRIES) {
					throw new Error(`Invalid span: objects must contain at most ${MAX_OTLP_ATTRIBUTE_ENTRIES} string keys`)
				}
				if (key.length === 0 || key.length > 1_024) throw new Error('Invalid span: object key limit exceeded')
				if (!descriptor?.enumerable || !('value' in descriptor)) {
					throw new Error('Invalid span: objects must contain enumerable data properties')
				}
				consumeCharacters(key.length)
				result[key] = snapshotGraph(descriptor.value, depth + 1)
			}
			return result
		} finally { deleteNativeWeakSet(active, candidate) }
	}
	type Projection = (candidate: unknown, depth: number) => unknown
	const snapshotKnownObject = (
		candidate: unknown,
		depth: number,
		label: string,
		fields: readonly (readonly [string, Projection])[]
	): Record<string, unknown> => {
		const source = inspectObject(candidate, depth, label)
		const result = nativeObjectCreate(null) as Record<string, unknown>
		addNativeWeakSet(active, source)
		try {
			for (let index = 0; index < fields.length; index += 1) {
				const field = fields[index]!
				const key = field[0]
				let descriptor: PropertyDescriptor | undefined
				try { descriptor = nativeObjectGetOwnPropertyDescriptor(source, key) } catch {
					throw new Error(`Invalid span: ${label} cannot be inspected safely`)
				}
				// Match ordinary object serialization: absent and non-enumerable fields
				// are not part of the input record. Enumerable accessors are rejected
				// without invocation.
				if (!descriptor?.enumerable) continue
				if (!('value' in descriptor)) throw new Error(`Invalid span: ${label} must use data properties`)
				consumeCharacters(key.length)
				result[key] = field[1](descriptor.value, depth + 1)
			}
			return result
		} finally { deleteNativeWeakSet(active, source) }
	}
	const snapshotKnownArray = (
		candidate: unknown,
		depth: number,
		label: string,
		project: Projection
	): unknown[] => {
		containNativePromiseUnchecked(candidate)
		consumeNode()
		if (!candidate || typeof candidate !== 'object' || isProxyObject(candidate)
			|| !nativeArrayIsArray(candidate)) throw new Error(`Invalid span: ${label} must be an array`)
		if (depth > MAX_OTLP_SNAPSHOT_DEPTH) throw new Error('Invalid span: snapshot nesting limit exceeded')
		if (hasNativeWeakSet(active, candidate)) throw new Error('Invalid span: circular data graph')
		const length = nativeObjectGetOwnPropertyDescriptor(candidate, 'length')?.value as unknown
		if (!nativeNumberIsSafeInteger(length) || (length as number) < 0
			|| (length as number) > MAX_OTLP_ATTRIBUTE_ENTRIES) {
			throw new Error(`Invalid span: ${label} must contain at most ${MAX_OTLP_ATTRIBUTE_ENTRIES} entries`)
		}
		const result: unknown[] = []
		addNativeWeakSet(active, candidate)
		try {
			for (let index = 0; index < (length as number); index += 1) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(candidate, index)
				if (!descriptor?.enumerable || !('value' in descriptor)) {
					throw new Error(`Invalid span: ${label} must be a dense data array`)
				}
				pushNativeArray(result, project(descriptor.value, depth + 1))
			}
			return result
		} finally { deleteNativeWeakSet(active, candidate) }
	}
	const primitive: Projection = (candidate, depth) => snapshotGraph(candidate, depth)
	const spanContext: Projection = (candidate, depth) => snapshotKnownObject(candidate, depth, 'context', [
		['traceId', primitive], ['spanId', primitive], ['parentSpanId', primitive],
		['traceFlags', primitive], ['traceState', primitive]
	])
	const status: Projection = (candidate, depth) => snapshotKnownObject(candidate, depth, 'status', [
		['code', primitive], ['description', primitive]
	])
	const event: Projection = (candidate, depth) => snapshotKnownObject(candidate, depth, 'event', [
		['name', primitive], ['timestamp', primitive], ['attributes', snapshotGraph]
	])
	const link: Projection = (candidate, depth) => snapshotKnownObject(candidate, depth, 'link', [
		['context', spanContext], ['attributes', snapshotGraph]
	])
	const events: Projection = (candidate, depth) => snapshotKnownArray(candidate, depth, 'events', event)
	const links: Projection = (candidate, depth) => snapshotKnownArray(candidate, depth, 'links', link)
	return snapshotKnownObject(value, 0, 'record', [
		['name', primitive], ['kind', primitive], ['context', spanContext],
		['parentContext', spanContext], ['startTime', primitive], ['endTime', primitive],
		['durationMs', primitive], ['attributes', snapshotGraph], ['status', status],
		['events', events], ['links', links], ['droppedAttributesCount', primitive],
		['droppedEventsCount', primitive], ['droppedLinksCount', primitive],
		['resource', snapshotGraph]
	]) as unknown as SpanRecord
}

/**
 * Structured export outcome.
 */
export type SpanExportStatus =
	| 'success'
	| 'partial'
	| 'retryable'
	| 'throttled'
	| 'permanent-failure'

/**
 * Structured export result for service-layer resilience.
 */
export interface SpanExportResult {

	/** Export outcome */
	status: SpanExportStatus

	/** Accepted span count, treated as a prefix length */
	acceptedCount: number

	/** Optional retry delay */
	retryAfterMs?: number

	/** Optional error */
	error?: Error
}

/**
 * OTLP span exporter interface.
 * Implementations handle the actual transport (HTTP, gRPC, etc.).
 */
export interface SpanExporter {

	/**
	 * Export spans to the backend.
	 * @param spans - Spans to export
	 * @returns Promise that resolves when export is complete
	 */
	export(spans: readonly SpanRecord[]): Promise<SpanExportResult>

	/**
	 * Shutdown the exporter (flush pending spans, close connections).
	 * @returns Promise that resolves when shutdown is complete
	 */
	shutdown(): Promise<void>
}

/**
 * Convert nanoseconds to OTLP timestamp (Unix epoch nanoseconds as string).
 * @param epochMs - Epoch milliseconds
 * @returns OTLP timestamp string
 */
function toOtlpTimestamp(epochMs: number): string {
	const wholeMilliseconds = nativeMathTrunc(epochMs)
	const fractionalNanoseconds = nativeMathFloor((epochMs - wholeMilliseconds) * 1_000_000)
	const nanos = (nativeReflectApply(NativeBigInt, undefined, [wholeMilliseconds]) as bigint) * 1_000_000n
		+ (nativeReflectApply(NativeBigInt, undefined, [fractionalNanoseconds]) as bigint)
	return nativeReflectApply(nativeBigIntToString, nanos, []) as string
}

/**
 * Validate a span record before serialization.
 * @param span - Span record to validate
 * @throws Error if span is invalid
 */
function validateSpanRecord(span: SpanRecord): asserts span is SpanRecord {
	if (!span || typeof span !== 'object') throw new Error('Invalid span: record must be an object')
	if (typeof span.name !== 'string' || span.name.length === 0 || span.name.length > 256 || hasControlCharacters(span.name)) {
		throw new Error('Invalid span: name must be 1-256 characters without control characters')
	}
	if (!span.context || typeof span.context !== 'object') throw new Error('Invalid span: context is required')

	// Validate traceId: 32 hex chars
	if (!span.context.traceId || typeof span.context.traceId !== 'string') {
		throw new Error('Invalid span: traceId is required and must be a string')
	}
	if (span.context.traceId.length !== 32) {
		throw new Error(`Invalid span: traceId must be 32 characters, got ${span.context.traceId.length}`)
	}
	if (!matches(LOWER_HEX, span.context.traceId)) {
		throw new Error('Invalid span: traceId must be hexadecimal using lower-case characters')
	}
	if (matches(ZERO_TRACE_ID, span.context.traceId)) throw new Error('Invalid span: traceId cannot be all zeros')

	// Validate spanId: 16 hex chars
	if (!span.context.spanId || typeof span.context.spanId !== 'string') {
		throw new Error('Invalid span: spanId is required and must be a string')
	}
	if (span.context.spanId.length !== 16) {
		throw new Error(`Invalid span: spanId must be 16 characters, got ${span.context.spanId.length}`)
	}
	if (!matches(LOWER_HEX, span.context.spanId)) {
		throw new Error('Invalid span: spanId must be hexadecimal using lower-case characters')
	}
	if (matches(ZERO_SPAN_ID, span.context.spanId)) throw new Error('Invalid span: spanId cannot be all zeros')
	if (span.context.traceFlags !== undefined && (
		!nativeNumberIsInteger(span.context.traceFlags) || span.context.traceFlags < 0 || span.context.traceFlags > 255
	)) {
		throw new Error('Invalid span: traceFlags must be an integer between 0 and 255')
	}
	const parentSpanId = span.parentContext?.spanId ?? span.context.parentSpanId
	if (parentSpanId !== undefined && (
		!matches(VALID_SPAN_ID, parentSpanId) || matches(ZERO_SPAN_ID, parentSpanId)
	)) {
		throw new Error('Invalid span: parentSpanId must be 16 non-zero hexadecimal characters')
	}
	if (span.parentContext !== undefined) {
		if (!span.parentContext || typeof span.parentContext !== 'object' ||
			!matches(VALID_TRACE_ID, span.parentContext.traceId) || matches(ZERO_TRACE_ID, span.parentContext.traceId) ||
			!matches(VALID_SPAN_ID, span.parentContext.spanId) || matches(ZERO_SPAN_ID, span.parentContext.spanId)) {
			throw new Error('Invalid span: parentContext must contain valid lower-case W3C identifiers')
		}
		if (span.parentContext.traceId !== span.context.traceId) {
			throw new Error('Invalid span: parentContext must belong to the same trace')
		}
		if (span.context.parentSpanId !== undefined && span.context.parentSpanId !== span.parentContext.spanId) {
			throw new Error('Invalid span: parentContext conflicts with context.parentSpanId')
		}
	}
	if (span.context.traceState !== undefined && !isValidTraceState(span.context.traceState)) {
		throw new Error('Invalid span: traceState does not conform to W3C Trace Context')
	}

	// Validate timestamps
	if (typeof span.startTime !== 'number' || !nativeNumberIsFinite(span.startTime) ||
		!nativeNumberIsSafeInteger(nativeMathTrunc(span.startTime))) {
		throw new Error('Invalid span: startTime must be a finite number')
	}
	if (span.startTime < 0 || span.startTime > MAX_OTLP_TIMESTAMP_MS) {
		throw new Error(`Invalid span: startTime must be between 0 and ${MAX_OTLP_TIMESTAMP_MS}`)
	}
	if (span.endTime !== undefined) {
		if (typeof span.endTime !== 'number' || !nativeNumberIsFinite(span.endTime) ||
			!nativeNumberIsSafeInteger(nativeMathTrunc(span.endTime))) {
			throw new Error('Invalid span: endTime must be a finite number or undefined')
		}
		if (span.endTime < 0 || span.endTime > MAX_OTLP_TIMESTAMP_MS) {
			throw new Error(`Invalid span: endTime must be between 0 and ${MAX_OTLP_TIMESTAMP_MS}`)
		}
		if (span.endTime < span.startTime) {
			throw new Error(`Invalid span: endTime (${span.endTime}) must be >= startTime (${span.startTime})`)
		}
	}
	if (span.durationMs !== undefined) {
		if (typeof span.durationMs !== 'number' || !nativeNumberIsFinite(span.durationMs) || span.durationMs < 0) {
			throw new Error('Invalid span: durationMs must be a finite non-negative number or undefined')
		}
		if (span.endTime === undefined && span.startTime + span.durationMs > MAX_OTLP_TIMESTAMP_MS) {
			throw new Error(`Invalid span: startTime + durationMs must be at most ${MAX_OTLP_TIMESTAMP_MS}`)
		}
	}

	// Validate span kind
	const validKinds = ['internal', 'server', 'client', 'producer', 'consumer']
	if (!(nativeReflectApply(nativeArrayIncludes, validKinds, [span.kind]) as boolean)) {
		throw new Error(`Invalid span: kind must be one of ${
			nativeReflectApply(nativeArrayJoin, validKinds, [', ']) as string
		}, got ${span.kind}`)
	}

	// Validate status code
	if (!span.status || typeof span.status !== 'object') throw new Error('Invalid span: status is required')
	const validStatusCodes = ['unset', 'ok', 'error']
	if (!(nativeReflectApply(nativeArrayIncludes, validStatusCodes, [span.status.code]) as boolean)) {
		throw new Error(`Invalid span: status.code must be one of ${
			nativeReflectApply(nativeArrayJoin, validStatusCodes, [', ']) as string
		}, got ${span.status.code}`)
	}
	if (span.status.description !== undefined && (
		typeof span.status.description !== 'string' || span.status.description.length > 1_024
	)) throw new Error('Invalid span: status.description must be a string with at most 1024 characters')
	if (!span.attributes || typeof span.attributes !== 'object' || nativeArrayIsArray(span.attributes)) throw new Error('Invalid span: attributes must be an object')
	if (!nativeArrayIsArray(span.events) || span.events.length > 10_000) throw new Error('Invalid span: events must be an array with at most 10000 entries')
	for (let index = 0; index < span.events.length; index += 1) {
		const event = span.events[index]!
		if (!event || typeof event.name !== 'string' || event.name.length === 0 || event.name.length > 128 || hasControlCharacters(event.name)) {
			throw new Error(`Invalid span: events[${index}].name must be 1-128 characters`)
		}
		if (!nativeNumberIsFinite(event.timestamp) || !nativeNumberIsSafeInteger(nativeMathTrunc(event.timestamp))
			|| event.timestamp < 0 || event.timestamp > MAX_OTLP_TIMESTAMP_MS) {
			throw new Error(`Invalid span: events[${index}].timestamp is outside the OTLP uint64 range`)
		}
	}

	// Validate resource (if present)
	if (span.resource !== undefined) {
		if (typeof span.resource !== 'object' || span.resource === null || nativeArrayIsArray(span.resource)) {
			throw new Error('Invalid span: resource must be a plain object or undefined')
		}
	}

	// Validate resource attributes (if present)
	if (span.resource !== undefined) {
		const resourceEntries = readDataEntries(span.resource)
		for (let index = 0; index < resourceEntries.length; index += 1) {
			const entry = resourceEntries[index]!
			const key = entry[0]
			const value = entry[1]
			if (typeof key !== 'string' || key.length === 0) {
				throw new Error('Invalid span: resource keys must be non-empty strings')
			}
			// Values can be any JSON-serializable type, but validate basic types
			if (value !== null && typeof value === 'object' && !nativeArrayIsArray(value)) {
				// Nested objects are allowed but should be validated recursively if needed
				// For now, just ensure it's a plain object
				if (nativeObjectGetPrototypeOf(value) !==
				nativeObjectPrototype && nativeObjectGetPrototypeOf(value) !== null) {
					throw new Error(`Invalid span: resource attribute "${key}" must be a plain object, array, or primitive value`)
				}
			}
		}
	}

	// Validate links (if present)
	if (span.links !== undefined) {
		if (!nativeArrayIsArray(span.links)) {
			throw new Error('Invalid span: links must be an array or undefined')
		}
		if (span.links.length > 10_000) throw new Error('Invalid span: links must contain at most 10000 entries')
		for (let i = 0; i < span.links.length; i++) {
			const link = span.links[i]
			if (!link || typeof link !== 'object') {
				throw new Error(`Invalid span: links[${i}] must be an object`)
			}
			if (!link.context || typeof link.context !== 'object') {
				throw new Error(`Invalid span: links[${i}].context is required and must be an object`)
			}
			// Validate link context traceId
			if (!link.context.traceId || typeof link.context.traceId !== 'string') {
				throw new Error(`Invalid span: links[${i}].context.traceId is required and must be a string`)
			}
			if (link.context.traceId.length !== 32) {
				throw new Error(`Invalid span: links[${i}].context.traceId must be 32 characters, got ${link.context.traceId.length}`)
			}
			if (!matches(LOWER_HEX, link.context.traceId)) {
				throw new Error(`Invalid span: links[${i}].context.traceId must be hexadecimal using lower-case characters`)
			}
			if (matches(ZERO_TRACE_ID, link.context.traceId)) throw new Error(`Invalid span: links[${i}].context.traceId cannot be all zeros`)
			// Validate link context spanId
			if (!link.context.spanId || typeof link.context.spanId !== 'string') {
				throw new Error(`Invalid span: links[${i}].context.spanId is required and must be a string`)
			}
			if (link.context.spanId.length !== 16) {
				throw new Error(`Invalid span: links[${i}].context.spanId must be 16 characters, got ${link.context.spanId.length}`)
			}
			if (!matches(LOWER_HEX, link.context.spanId)) {
				throw new Error(`Invalid span: links[${i}].context.spanId must be hexadecimal using lower-case characters`)
			}
			if (matches(ZERO_SPAN_ID, link.context.spanId)) throw new Error(`Invalid span: links[${i}].context.spanId cannot be all zeros`)
			if (link.context.traceState !== undefined && !isValidTraceState(link.context.traceState)) {
				throw new Error(`Invalid span: links[${i}].context.traceState is invalid`)
			}
			// Validate link attributes (if present)
			if (link.attributes !== undefined) {
				if (typeof link.attributes !== 'object' || link.attributes === null || nativeArrayIsArray(link.attributes)) {
					throw new Error(`Invalid span: links[${i}].attributes must be a plain object or undefined`)
				}
			}
		}
	}
	const droppedCounts = [
		['droppedAttributesCount', span.droppedAttributesCount],
		['droppedEventsCount', span.droppedEventsCount],
		['droppedLinksCount', span.droppedLinksCount]
	] as const
	for (let index = 0; index < droppedCounts.length; index += 1) {
		const entry = droppedCounts[index]!
		const field = entry[0]
		const value = entry[1]
		if (value !== undefined && (!nativeNumberIsSafeInteger(value) || value < 0 || value > MAX_OTLP_DROPPED_COUNT)) {
			throw new Error(`Invalid span: ${field} must be an OTLP uint32`)
		}
	}
}

/**
 * Serialize a span record to OTLP/JSON format.
 * @param span - Span record
 * @returns OTLP span JSON object
 */
export function serializeSpanToOtlp(span: SpanRecord): Record<string, unknown> {
	return serializeSnapshotSpanToOtlp(snapshotSpanInput(span))
}

function serializeSnapshotSpanToOtlp(span: SpanRecord): Record<string, unknown> {

	// Validate span before serialization
	validateSpanRecord(span)
	const attributeBudget = createAttributeBudget()
	const resolvedEndTime = span.endTime ?? (
		span.durationMs !== undefined ? span.startTime + span.durationMs : span.startTime
	)

	const events: Array<Record<string, unknown>> = []
	for (let index = 0; index < span.events.length; index += 1) {
		const event = span.events[index]!
		pushNativeArray(events, {
			timeUnixNano: toOtlpTimestamp(event.timestamp),
			name: event.name,
			attributes: event.attributes ? attributesToOtlp(event.attributes, attributeBudget) : []
		})
	}
	const links: Array<Record<string, unknown>> = []
	if (span.links) {
		for (let index = 0; index < span.links.length; index += 1) {
			const link = span.links[index]!
			pushNativeArray(links, {
				traceId: link.context.traceId,
				spanId: link.context.spanId,
				traceState: link.context.traceState || '',
				attributes: link.attributes ? attributesToOtlp(link.attributes, attributeBudget) : []
			})
		}
	}

	return {
		traceId: span.context.traceId,
		spanId: span.context.spanId,
		traceState: span.context.traceState || '',
		parentSpanId: span.parentContext?.spanId || span.context.parentSpanId || '',
		name: span.name,
		kind: spanKindToOtlp(span.kind),
		startTimeUnixNano: toOtlpTimestamp(span.startTime),
		endTimeUnixNano: toOtlpTimestamp(resolvedEndTime),
		attributes: attributesToOtlp(span.attributes, attributeBudget),
		status: {
			code: statusCodeToOtlp(span.status.code),
			message: span.status.description || ''
		},
		events,
		links,
		droppedAttributesCount: span.droppedAttributesCount || 0,
		droppedEventsCount: span.droppedEventsCount || 0,
		droppedLinksCount: span.droppedLinksCount || 0
	}
}

/**
 * Convert span kind to OTLP enum value.
 */
function spanKindToOtlp(kind: string): number {

	switch (kind) {
		case 'internal': return 1
		case 'server': return 2
		case 'client': return 3
		case 'producer': return 4
		case 'consumer': return 5
		default: return 0
	}
}

/**
 * Convert status code to OTLP enum value.
 */
function statusCodeToOtlp(code: string): number {

	switch (code) {
		case 'unset': return 0
		case 'ok': return 1
		case 'error': return 2
		default: return 0
	}
}

/**
 * Convert attributes to OTLP key-value array format.
 */
function readDataEntries(value: object): Array<[string, unknown]> {
	if (isProxyObject(value)) throw new Error('Invalid span: Proxy data is not supported')
	let keys: PropertyKey[]
	try { keys = nativeReflectOwnKeys(value) } catch { throw new Error('Invalid span: attributes cannot be inspected safely') }
	if (keys.length > MAX_OTLP_ATTRIBUTE_ENTRIES) {
		throw new Error(`Invalid span: attributes must contain at most ${MAX_OTLP_ATTRIBUTE_ENTRIES} string keys`)
	}
	const entries: Array<[string, unknown]> = []
	for (let index = 0; index < keys.length; index += 1) {
		const key = keys[index]
		if (typeof key !== 'string') {
			throw new Error(`Invalid span: attributes must contain at most ${MAX_OTLP_ATTRIBUTE_ENTRIES} string keys`)
		}
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = nativeObjectGetOwnPropertyDescriptor(value, key) } catch {
			throw new Error('Invalid span: attributes cannot be inspected safely')
		}
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new Error('Invalid span: attributes must contain enumerable data properties')
		}
		if (key.length === 0 || key.length > 1_024 || hasControlCharacters(key)) {
			throw new Error('Invalid span: attribute keys must be 1-1024 characters without control characters')
		}
		pushNativeArray(entries, [key, descriptor.value])
	}
	return entries
}

function attributesToOtlp(
	attrs: Record<string, unknown>,
	budget: OtlpAttributeBudget
): Array<{key: string; value: unknown}> {

	const result: Array<{key: string; value: unknown}> = []

	const entries = readDataEntries(attrs)
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!
		const key = entry[0]
		const val = entry[1]

		if (val === undefined || val === null) {
			continue
		}
		budget.characters -= key.length
		if (budget.characters < 0) throw new Error('Invalid span: aggregate attribute character limit exceeded')

		// OTLP value format
		pushNativeArray(result, {key, value: toOtlpAnyValue(val, 0, budget, new NativeWeakSet<object>())})
	}

	return result
}

function toOtlpAnyValue(
	value: unknown,
	depth: number,
	budget: OtlpAttributeBudget,
	seen: WeakSet<object>
): unknown {
	if (budget.nodes-- <= 0) throw new Error('Invalid span: aggregate attribute node limit exceeded')
	if (depth > 8) throw new Error('Invalid span: attribute nesting exceeds 8 levels')
	if (value === null) return {stringValue: 'null'}
	if (typeof value === 'string') {
		if (value.length > MAX_OTLP_ATTRIBUTE_STRING || value.length > budget.characters) {
			throw new Error('Invalid span: attribute string limit exceeded')
		}
		budget.characters -= value.length
		return {stringValue: value}
	}
	if (typeof value === 'number') {
		if (!nativeNumberIsFinite(value)) throw new Error('Invalid span: numeric attributes must be finite')
		return nativeNumberIsSafeInteger(value) ? {
			intValue: nativeReflectApply(nativeNumberToString, value, []) as string
		} : {doubleValue: value}
	}
	if (typeof value === 'boolean') return {boolValue: value}
	if (nativeArrayIsArray(value)) {
		if (hasNativeWeakSet(seen, value)) throw new Error('Invalid span: circular attribute value')
		const length = nativeObjectGetOwnPropertyDescriptor(value, 'length')?.value as unknown
		if (!nativeNumberIsSafeInteger(length) || (length as number) < 0
			|| (length as number) > MAX_OTLP_ATTRIBUTE_ENTRIES) {
			throw new Error(`Invalid span: attribute arrays must contain at most ${MAX_OTLP_ATTRIBUTE_ENTRIES} entries`)
		}
		addNativeWeakSet(seen, value)
		try {
			const values: unknown[] = []
			for (let index = 0; index < (length as number); index += 1) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(value, index)
				if (!descriptor?.enumerable || !('value' in descriptor)) {
					throw new Error('Invalid span: attribute arrays must be dense data arrays')
				}
				pushNativeArray(values, toOtlpAnyValue(descriptor.value, depth + 1, budget, seen))
			}
			return {arrayValue: {values}}
		} finally { deleteNativeWeakSet(seen, value) }
	}
	if (value && typeof value === 'object') {
		if (hasNativeWeakSet(seen, value)) throw new Error('Invalid span: circular attribute value')
		let prototype: object | null
		try { prototype = nativeObjectGetPrototypeOf(value) as object | null } catch {
			throw new Error('Invalid span: attributes cannot be inspected safely')
		}
		if (prototype !== nativeObjectPrototype && prototype !== null) {
			throw new Error('Invalid span: nested attributes must be plain objects')
		}
		addNativeWeakSet(seen, value)
		try {
			const entries = readDataEntries(value)
			const values: Array<{key: string; value: unknown}> = []
			for (let index = 0; index < entries.length; index += 1) {
				const sourceEntry = entries[index]!
				const key = sourceEntry[0]
				const entry = sourceEntry[1]
				budget.characters -= key.length
				if (budget.characters < 0) throw new Error('Invalid span: aggregate attribute character limit exceeded')
				pushNativeArray(values, {key, value: toOtlpAnyValue(entry, depth + 1, budget, seen)})
			}
			return {kvlistValue: {values}}
		} finally { deleteNativeWeakSet(seen, value) }
	}
	throw new Error(`Invalid span: unsupported attribute type ${typeof value}`)
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = nativeReflectApply(nativeStringCharCodeAt, value, [index]) as number
		if (code <= 31 || code === 127) return true
	}
	return false
}

/**
 * Serialize spans to OTLP/JSON request body.
 * @param spans - Spans to serialize
 * @returns OTLP JSON request body
 */
export function serializeSpansToOtlpJson(spans: readonly SpanRecord[]): string {
	containNativePromiseUnchecked(spans)
	if (isProxyObject(spans) || !nativeArrayIsArray(spans)) throw new Error('Invalid spans: input must be an array')
	const length = nativeObjectGetOwnPropertyDescriptor(spans, 'length')?.value as unknown
	if (!nativeNumberIsSafeInteger(length) || (length as number) < 0 || (length as number) > MAX_OTLP_SPANS) {
		throw new Error(`Invalid spans: batch must contain at most ${MAX_OTLP_SPANS} entries`)
	}

	const resourceGroups = new NativeMap<string, {
		resourceAttributes: Array<{key: string; value: unknown}>
		spans: Record<string, unknown>[]
	}>()
	const snapshotBudget = createBatchSnapshotBudget()
	let remainingBytes = MAX_OTLP_JSON_BYTES - OTLP_JSON_ENTRY_OVERHEAD_BYTES

	for (let index = 0; index < (length as number); index += 1) {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(spans, index)
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new Error('Invalid spans: batch must be a dense data array')
		}
		containNativePromiseUnchecked(descriptor.value)
		const span = snapshotSpanInput(descriptor.value, snapshotBudget)
		const serializedSpan = serializeSnapshotSpanToOtlp(span)
		const serializedSpanBytes = byteSize(nativeJsonStringify(serializedSpan)) + OTLP_JSON_ENTRY_OVERHEAD_BYTES
		if (serializedSpanBytes > remainingBytes) {
			throw new Error(`Invalid spans: OTLP JSON payload must not exceed ${MAX_OTLP_JSON_BYTES} bytes`)
		}
		remainingBytes -= serializedSpanBytes
		const resource = span.resource ?? {}
		const resourceAttributes = attributesToOtlp(resource, createAttributeBudget())
		nativeReflectApply(nativeArraySort, resourceAttributes, [
			({key: a}: {key: string}, {key: b}: {key: string}) => a < b ? -1 : a > b ? 1 : 0
		])
		const resourceKey = nativeJsonStringify(resourceAttributes)
		let resourceGroup = getNativeMap(resourceGroups, resourceKey)
		if (!resourceGroup) {
			const resourceBytes = byteSize(resourceKey) + OTLP_JSON_ENTRY_OVERHEAD_BYTES
			if (resourceBytes > remainingBytes) {
				throw new Error(`Invalid spans: OTLP JSON payload must not exceed ${MAX_OTLP_JSON_BYTES} bytes`)
			}
			remainingBytes -= resourceBytes
			resourceGroup = {resourceAttributes, spans: []}
			setNativeMap(resourceGroups, resourceKey, resourceGroup)
		}
		pushNativeArray(resourceGroup.spans, serializedSpan)
	}

	const resourceSpans: Array<Record<string, unknown>> = []
	const resourceGroupValues = snapshotNativeMapValues(resourceGroups)
	for (let index = 0; index < resourceGroupValues.length; index += 1) {
		const resourceGroup = resourceGroupValues[index]!
		pushNativeArray(resourceSpans, {
			resource: {attributes: resourceGroup.resourceAttributes},
			scopeSpans: [{spans: resourceGroup.spans}]
		})
	}

	if (resourceSpans.length === 0) {
		pushNativeArray(resourceSpans, {
			resource: {
				attributes: []
			},
			scopeSpans: [{
				spans: []
			}]
		})
	}

	const serialized = nativeJsonStringify({resourceSpans})
	if (byteSize(serialized) > MAX_OTLP_JSON_BYTES) {
		throw new Error(`Invalid spans: OTLP JSON payload must not exceed ${MAX_OTLP_JSON_BYTES} bytes`)
	}
	return serialized
}
