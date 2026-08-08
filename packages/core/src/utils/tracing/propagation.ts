/**
 * @file W3C Trace Context propagation (traceparent, tracestate, baggage).
 * Implements W3C Trace Context specification for distributed tracing.
 */

import type {LogAttributes} from '../../contracts/logging'
import type {SpanContext} from '../../contracts/tracing'
import type {ExtractResult} from '../../ports/tracing'
import {containNativePromiseUnchecked} from '../../runtime/async/native-promise'
import {
	addNativeSet,
	getNativeMap,
	hasNativeMap,
	hasNativeSet,
	setNativeMap
} from '../../runtime/collections/native-collections'
import {byteSize} from '../byte-size'
import {hasSafePrototypeChain, isProxyObject} from '../safe-object'

const nativeReflectApply = Reflect.apply
const nativeArrayIsArray = Array.isArray
const nativeEncodeURIComponent = encodeURIComponent
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsInteger = Number.isInteger
const nativeNumberParseInt = Number.parseInt
const nativeRegExpTest = RegExp.prototype.test
const nativeStringCharCodeAt = String.prototype.charCodeAt
const nativeStringEndsWith = String.prototype.endsWith
const nativeStringIndexOf = String.prototype.indexOf
const nativeStringLastIndexOf = String.prototype.lastIndexOf
const nativeStringPadStart = String.prototype.padStart
const nativeStringRepeat = String.prototype.repeat
const nativeStringReplace = String.prototype.replace
const nativeStringSlice = String.prototype.slice
const nativeStringSplit = String.prototype.split
const nativeStringStartsWith = String.prototype.startsWith
const nativeStringSubstring = String.prototype.substring
const nativeStringToLowerCase = String.prototype.toLowerCase
const nativeNumberToString = Number.prototype.toString
const nativeArrayJoin = Array.prototype.join
const nativeObjectDefineProperty = Object.defineProperty
const nativeObjectCreate = Object.create
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectPrototype = Object.prototype
const NativeMap = Map
const NativeSet = Set
const nativeObjectIsExtensible = Object.isExtensible
const NativeTextDecoder = TextDecoder
const NativeString = String
const NativeUint8Array = Uint8Array
const nativeTextDecoderDecode = TextDecoder.prototype.decode
const baggageTextDecoder = new NativeTextDecoder()
const HEX = /^[0-9a-f]+$/u
const TRACE_ID = /^[0-9a-f]{32}$/iu
const ZERO_TRACE_ID = /^0{32}$/u
const SPAN_ID = /^[0-9a-f]{16}$/iu
const ZERO_SPAN_ID = /^0{16}$/u
const BAGGAGE_KEY = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const PERCENT_BYTE = /^[0-9a-f]{2}$/iu
const SIMPLE_TRACESTATE_KEY = /^[a-z][a-z0-9_*/-]{0,255}$/u
const MULTI_TENANT_TRACESTATE_KEY = /^(?:[a-z0-9][a-z0-9_*/-]{0,240})@[a-z][a-z0-9_*/-]{0,13}$/u

function matches(pattern: RegExp, value: string): boolean {
	return nativeReflectApply(nativeRegExpTest, pattern, [value]) as boolean
}

/**
 * W3C traceparent header format: version-traceid-parentid-flags
 * Example: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
 */

/** W3C traceparent version (currently only '00' is supported) */
export const TRACEPARENT_VERSION = '00'

/**
 * Total traceparent header length:
 * 2 (version) + 1 (dash) + 32 (traceId) + 1 (dash) + 16 (parentId) + 1 (dash) + 2 (flags) = 55
 */
export const TRACEPARENT_LENGTH = 55

/** Trace ID length in hex characters (128 bits = 32 hex chars) */
export const TRACE_ID_LENGTH = 32

/** Span ID length in hex characters (64 bits = 16 hex chars) */
export const SPAN_ID_LENGTH = 16

/** Flags field length in hex characters (8 bits = 2 hex chars) */
export const FLAGS_LENGTH = 2

/** Trace flags bitmask (sampled and random trace-id flags). */
export const TRACEPARENT_FLAGS_MASK = 0x3

/** Sampled flag (bit 0) */
export const TRACEPARENT_SAMPLED_FLAG = 0x1

/** Random trace-id flag (bit 1, W3C Trace Context Level 2). */
export const TRACEPARENT_RANDOM_FLAG = 0x2

const SPAN_CONTEXT_FIELDS = ['traceId', 'spanId', 'parentSpanId', 'traceFlags', 'traceState'] as const

function snapshotSpanContext(context: unknown): SpanContext {
	containNativePromiseUnchecked(context)
	const empty = (): SpanContext => nativeObjectCreate(null) as SpanContext
	if (!context || typeof context !== 'object') return empty()
	if (isProxyObject(context)) return empty()
	const snapshot = nativeObjectCreate(null) as Record<string, unknown>
	try {
		for (let index = 0; index < SPAN_CONTEXT_FIELDS.length; index += 1) {
			const field = SPAN_CONTEXT_FIELDS[index]!
			const descriptor = nativeObjectGetOwnPropertyDescriptor(context, field)
			if (descriptor && 'value' in descriptor) {
				containNativePromiseUnchecked(descriptor.value)
				snapshot[field] = descriptor.value
			}
		}
	} catch { return empty() }
	return snapshot as unknown as SpanContext
}

/**
 * Encode a span context into a W3C traceparent header.
 * @param ctx - Span context
 * @returns traceparent header value
 */
export function encodeTraceParent(ctx: SpanContext): string {
	return encodeSnapshotTraceParent(snapshotSpanContext(ctx))
}

function encodeSnapshotTraceParent(ctx: SpanContext): string {

	const version = TRACEPARENT_VERSION
	if (!isValidTraceId(ctx.traceId)) throw new Error('traceId must be 32 non-zero hexadecimal characters')
	if (!isValidSpanId(ctx.spanId)) throw new Error('spanId must be 16 non-zero hexadecimal characters')
	if (ctx.traceFlags !== undefined && (!nativeNumberIsInteger(ctx.traceFlags) || ctx.traceFlags < 0 || ctx.traceFlags > 255)) {
		throw new Error('traceFlags must be an integer between 0 and 255')
	}
	const traceId = nativeReflectApply(nativeStringToLowerCase, ctx.traceId, []) as string
	// W3C spec: third field is the current span's ID, not the parent's
	const spanId = nativeReflectApply(nativeStringToLowerCase, ctx.spanId, []) as string
	const flagText = nativeReflectApply(
		nativeNumberToString, (ctx.traceFlags ?? 0) & TRACEPARENT_FLAGS_MASK, [16]
	) as string
	const paddedFlags = nativeReflectApply(nativeStringPadStart, flagText, [FLAGS_LENGTH, '0']) as string
	const flags = nativeReflectApply(nativeStringSubstring, paddedFlags, [0, FLAGS_LENGTH]) as string

	return `${version}-${traceId}-${spanId}-${flags}`
}

/**
 * Decode a W3C traceparent header into a span context.
 * @param value - traceparent header value
 * @returns Span context or undefined if invalid
 */
export function decodeTraceParent(value: string): SpanContext | undefined {
	containNativePromiseUnchecked(value)

	if (!value || typeof value !== 'string') {
		return undefined
	}

	// Version 00 has a fixed length. Future versions are additive: W3C requires
	// implementations to parse the first 55 characters when the next character
	// is either the end of the value or the delimiter for unknown fields.
	if (value.length < TRACEPARENT_LENGTH || value.length > 512) {
		return undefined
	}
	if (value[2] !== '-' || value[35] !== '-' || value[52] !== '-') {
		return undefined
	}
	const version = nativeReflectApply(nativeStringSlice, value, [0, 2]) as string
	const traceId = nativeReflectApply(nativeStringSlice, value, [3, 35]) as string
	const parentId = nativeReflectApply(nativeStringSlice, value, [36, 52]) as string
	const flags = nativeReflectApply(nativeStringSlice, value, [53, 55]) as string

	// Validate all parts are present
	if (!version || !traceId || !parentId || !flags) {
		return undefined
	}

	if (!matches(HEX, version) || version === 'ff') {
		return undefined
	}
	if (version === TRACEPARENT_VERSION && value.length !== TRACEPARENT_LENGTH) {
		return undefined
	}
	if (version !== TRACEPARENT_VERSION && value.length > TRACEPARENT_LENGTH && value[TRACEPARENT_LENGTH] !== '-') {
		return undefined
	}

	// Validate lengths using constants
	if (
		traceId.length !== TRACE_ID_LENGTH ||
		parentId.length !== SPAN_ID_LENGTH ||
		flags.length !== FLAGS_LENGTH
	) {
		return undefined
	}

	// Validate hex characters
	// W3C Trace Context requires lower-case hexadecimal field values. Accepting
	// upper-case input produces a context that peers are required to reject.
	if (
		!matches(HEX, traceId) ||
		!matches(HEX, parentId) ||
		!matches(HEX, flags)
	) {
		return undefined
	}

	// W3C spec: reject all-zeros trace ID and span ID
	if (traceId === nativeReflectApply(nativeStringRepeat, '0', [TRACE_ID_LENGTH]) ||
		parentId === nativeReflectApply(nativeStringRepeat, '0', [SPAN_ID_LENGTH])) {
		return undefined
	}

	// Parse flags
	const traceFlags = nativeNumberParseInt(flags, 16)

	// Extract: parentId from header becomes the parentSpanId in context
	// We'll generate a new spanId when creating the child span
	const spanId = parentId

	const result: SpanContext = {
		traceId,
		spanId,
		parentSpanId: parentId, // Store extracted parent ID
		traceFlags
	}
	return result
}

/**
 * Encode baggage attributes into a W3C baggage header.
 * Format: key1=value1,key2=value2 (URL-encoded values)
 * @param attrs - Baggage attributes
 * @returns baggage header value
 */
export function encodeBaggage(attrs: LogAttributes): string {
	const pairs: string[] = []
	let totalBytes = 0
	const entries = readAttributeDataEntries(attrs)
	if (!entries) return ''
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!
		const key = entry[0]
		const value = entry[1]

		if (!key || typeof value === 'undefined' || value === null) {
			continue
		}

		if (!isValidBaggageKey(key) || isDangerousKey(key)) {
			continue
		}

		// Convert value to string and URL-encode
		let encodedValue: string
		try {
			const stringValue = typeof value === 'string' ? value
				: typeof value === 'boolean' ? (value ? 'true' : 'false')
					: typeof value === 'number' && nativeNumberIsFinite(value)
						? nativeReflectApply(NativeString, undefined, [value]) as string : undefined
			if (stringValue === undefined) continue
			// Raw UTF-8 bytes are a lower bound for the encoded representation.
			if (stringValue.length > 8_192 || byteSize(stringValue) > 8_192) continue
			encodedValue = nativeReflectApply(nativeEncodeURIComponent, globalThis, [stringValue]) as string
		} catch { continue }

		const pair = `${key}=${encodedValue}`
		const pairBytes = byteSize(pair) + (pairs.length > 0 ? 1 : 0)
		if (pairs.length >= 64 || totalBytes + pairBytes > 8_192) continue
		pairs[pairs.length] = pair
		totalBytes += pairBytes
	}

	return nativeReflectApply(nativeArrayJoin, pairs, [',']) as string
}

/**
 * Decode a W3C baggage header into attributes.
 * @param header - baggage header value
 * @returns Baggage attributes
 */
export function decodeBaggage(header: string): LogAttributes {
	containNativePromiseUnchecked(header)

	const attrs = nativeObjectCreate(null) as Record<string, string>

	if (!header || typeof header !== 'string' || header.length > 8_192 || byteSize(header) > 8_192) {
		return attrs as LogAttributes
	}

	// Split by comma
	const pairs = nativeReflectApply(nativeStringSplit, header, [',']) as string[]
	if (pairs.length > 64) return attrs as LogAttributes

	for (let index = 0; index < pairs.length; index += 1) {
		const pair = pairs[index]!

		const trimmed = trimOptionalWhitespace(pair)
		if (!trimmed) {
			continue
		}

		const equalIndex = nativeReflectApply(nativeStringIndexOf, trimmed, ['=']) as number
		if (equalIndex === -1) {
			continue
		}

		const key = trimOptionalWhitespace(nativeReflectApply(nativeStringSubstring, trimmed, [0, equalIndex]) as string)
		const remainder = nativeReflectApply(nativeStringSubstring, trimmed, [equalIndex + 1]) as string
		const valueAndProperties = nativeReflectApply(nativeStringSplit, remainder, [';']) as string[]
		const valueStr = trimOptionalWhitespace(valueAndProperties[0] ?? '')

		if (!key) {
			continue
		}

		// Validate key
		let validProperties = true
		for (let propertyIndex = 1; propertyIndex < valueAndProperties.length; propertyIndex += 1) {
			if (!isValidBaggageProperty(valueAndProperties[propertyIndex]!)) {
				validProperties = false
				break
			}
		}
		if (!isValidBaggageKey(key) || isDangerousKey(key) || !validProperties) {
			continue
		}

		const decodedValue = decodeBaggageValue(valueStr)
		if (decodedValue !== undefined) attrs[key] = decodedValue
	}

	return attrs as LogAttributes
}

/**
 * Inject W3C trace context into a carrier (headers object).
 * @param carrier - Headers object to inject into
 * @param context - Span context to inject
 * @param baggage - Optional baggage attributes
 */
export function injectW3C(
	carrier: Record<string, string>,
	context: SpanContext,
	baggage?: LogAttributes
): void {
	const stableContext = snapshotSpanContext(context)
	const traceparent = encodeSnapshotTraceParent(stableContext)
	if (stableContext.traceState && !isValidTraceState(stableContext.traceState)) {
		throw new Error('tracestate does not conform to the W3C Trace Context grammar and limits')
	}
	const baggageValue = baggage ? encodeBaggage(baggage) : ''
	installHeaderValues(carrier, [
		['traceparent', traceparent],
		['tracestate', stableContext.traceState || undefined],
		['baggage', baggageValue || undefined]
	])
}

/**
 * Extract W3C trace context from a carrier (headers object).
 * @param carrier - Headers object to extract from
 * @returns Extract result with context and optional baggage
 */
export function extractW3C(carrier: Record<string, string>): ExtractResult {

	const result = nativeObjectCreate(null) as ExtractResult
	const headers = snapshotTracingHeaders(carrier)
	if (!headers) return result

	// Extract traceparent
	const traceparent = headers.values.traceparent
	if (traceparent) {
		const context = decodeTraceParent(traceparent)
		if (context) {
			// Extract tracestate if present
			const tracestate = headers.values.tracestate
			if (isValidTraceState(tracestate)) {
				context.traceState = tracestate
			}

			result.context = context
		}
	}

	// Extract baggage
	const baggageHeader = headers.values.baggage
	if (baggageHeader) {
		result.baggage = decodeBaggage(baggageHeader)
	}

	return result
}

function snapshotTracingHeaders(carrier: Record<string, string>): {
	values: Partial<Record<'traceparent' | 'tracestate' | 'baggage' | 'x-trace-id', string>>
} | undefined {
	containNativePromiseUnchecked(carrier)
	try {
		if (!carrier || typeof carrier !== 'object' || nativeArrayIsArray(carrier)) return undefined
		if (!hasSafePrototypeChain(carrier)) return undefined
		const values = nativeObjectCreate(null) as Partial<
			Record<'traceparent' | 'tracestate' | 'baggage' | 'x-trace-id', string>
		>
		const conflicts = new NativeSet<string>()
		let scanned = 0
		for (const key in carrier) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(carrier, key)
			if (!descriptor) break
			if (++scanned > 1_024) return undefined
			if (!descriptor?.enumerable || !('value' in descriptor)) continue
			containNativePromiseUnchecked(descriptor.value)
			if (typeof descriptor.value !== 'string') continue
			const normalized = nativeReflectApply(nativeStringToLowerCase, key, []) as string
			if (normalized !== 'traceparent' && normalized !== 'tracestate'
				&& normalized !== 'baggage' && normalized !== 'x-trace-id') continue
			if (hasNativeSet(conflicts, normalized)) continue
			const previous = values[normalized]
			if (previous !== undefined && previous !== descriptor.value) {
				delete values[normalized]
				addNativeSet(conflicts, normalized)
			}
			else if (previous === undefined) values[normalized] = descriptor.value
		}
		return {values}
	} catch { return undefined }
}

/**
 * Fallback: extract x-trace-id header.
 * @param carrier - Headers object
 * @returns Trace ID if found
 */
export function extractXTraceId(carrier: Record<string, string>): string | undefined {
	const value = snapshotTracingHeaders(carrier)?.values['x-trace-id']
	return value && isValidTraceId(value)
		? nativeReflectApply(nativeStringToLowerCase, value, []) as string : undefined
}

/**
 * Fallback: inject x-trace-id header.
 * @param carrier - Headers object
 * @param traceId - Trace ID to inject
 */
export function injectXTraceId(carrier: Record<string, string>, traceId: string): void {
	containNativePromiseUnchecked(traceId)

	if (!isValidTraceId(traceId)) throw new Error('x-trace-id must be 32 non-zero hexadecimal characters')
	installHeaderValues(carrier, [[
		'x-trace-id', nativeReflectApply(nativeStringToLowerCase, traceId, []) as string
	]])
}

function installHeaderValues(
	carrier: Record<string, string>,
	values: readonly (readonly [string, string | undefined])[]
): void {
	containNativePromiseUnchecked(carrier)
	if (!carrier || typeof carrier !== 'object' || nativeArrayIsArray(carrier)) {
		throw new TypeError('Tracing header carrier must be a plain data object')
	}
	if (isProxyObject(carrier)) throw new TypeError('Tracing header carrier must not be a Proxy')
	const prototype = nativeObjectGetPrototypeOf(carrier)
	if (prototype !== nativeObjectPrototype && prototype !== null) {
		throw new TypeError('Tracing header carrier must be a plain data object')
	}
	const fields = new NativeMap<string, PropertyDescriptor>()
	const fieldKeys: string[] = []
	const hasConfiguredHeader = (name: string): boolean => {
		for (let index = 0; index < values.length; index += 1) {
			if (values[index]![0] === name) return true
		}
		return false
	}
	let scanned = 0
	for (const key in carrier) {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(carrier, key)
		if (!descriptor) break
		if (++scanned > 1_024) throw new Error('Tracing header carrier contains too many fields')
		const normalized = nativeReflectApply(nativeStringToLowerCase, key, []) as string
		if (!hasConfiguredHeader(normalized)) continue
		if (!('value' in descriptor)) throw new Error('Tracing header carrier contains accessor-backed fields')
		containNativePromiseUnchecked(descriptor.value)
		if (hasNativeMap(fields, key)) throw new Error('Tracing header carrier contains duplicate fields')
		setNativeMap(fields, key, descriptor)
		fieldKeys[fieldKeys.length] = key
	}
	// `for...in` intentionally avoids materializing an attacker-sized own-key
	// array, but it cannot see a non-enumerable canonical header. Inspect the
	// small fixed canonical set directly so immutable hidden fields are included
	// in the mutation preflight and cannot cause a partial update later.
	for (let index = 0; index < values.length; index += 1) {
		const canonical = values[index]![0]
		if (hasNativeMap(fields, canonical)) continue
		const descriptor = nativeObjectGetOwnPropertyDescriptor(carrier, canonical)
		if (!descriptor) continue
		if (!('value' in descriptor)) throw new Error('Tracing header carrier contains accessor-backed fields')
		containNativePromiseUnchecked(descriptor.value)
		setNativeMap(fields, canonical, descriptor)
		fieldKeys[fieldKeys.length] = canonical
	}

	for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
		const entry = values[valueIndex]!
		const canonical = entry[0]
		const value = entry[1]
		const canonicalDescriptor = getNativeMap(fields, canonical)
		for (let fieldIndex = 0; fieldIndex < fieldKeys.length; fieldIndex += 1) {
			const key = fieldKeys[fieldIndex]!
			if (nativeReflectApply(nativeStringToLowerCase, key, []) !== canonical) continue
			const descriptor = getNativeMap(fields, key)!
			if (key !== canonical && !descriptor.configurable) {
				throw new Error('Tracing header carrier contains immutable case variants')
			}
		}
		if (value === undefined) {
			if (canonicalDescriptor && !canonicalDescriptor.configurable) {
				throw new Error('Tracing header carrier contains immutable stale fields')
			}
		} else if (canonicalDescriptor) {
			if (!canonicalDescriptor.configurable && canonicalDescriptor.writable !== true) {
				throw new Error('Tracing header carrier contains immutable tracing fields')
			}
		} else if (!nativeObjectIsExtensible(carrier)) {
			throw new Error('Tracing header carrier is not extensible')
		}
	}

	for (let index = 0; index < fieldKeys.length; index += 1) {
		const key = fieldKeys[index]!
		const normalized = nativeReflectApply(nativeStringToLowerCase, key, []) as string
		if (!hasConfiguredHeader(normalized) || key === normalized) continue
		delete carrier[key]
	}
	for (let index = 0; index < values.length; index += 1) {
		const entry = values[index]!
		const canonical = entry[0]
		const value = entry[1]
		if (value === undefined) {
			delete carrier[canonical]
			continue
		}
		const existing = getNativeMap(fields, canonical)
		nativeObjectDefineProperty(carrier, canonical, existing && !existing.configurable
			? {value}
			: {value, enumerable: true, configurable: true, writable: true})
	}
}

function isValidTraceId(value: unknown): value is string {
	return typeof value === 'string' && matches(TRACE_ID, value) && !matches(ZERO_TRACE_ID, value)
}

function isValidSpanId(value: unknown): value is string {
	return typeof value === 'string' && matches(SPAN_ID, value) && !matches(ZERO_SPAN_ID, value)
}

/** RFC 7230 token validation used by W3C baggage keys and properties. */
export function isValidBaggageKey(value: unknown): value is string {
	containNativePromiseUnchecked(value)
	return typeof value === 'string' && value.length > 0 && value.length <= 256 && matches(BAGGAGE_KEY, value)
}

function readAttributeDataEntries(attrs: LogAttributes): Array<[string, unknown]> | undefined {
	containNativePromiseUnchecked(attrs)
	try {
		if (!attrs || typeof attrs !== 'object' || nativeArrayIsArray(attrs)) return undefined
		if (isProxyObject(attrs)) return undefined
		const prototype = nativeObjectGetPrototypeOf(attrs)
		if (prototype !== nativeObjectPrototype && prototype !== null) return undefined
		const entries: Array<[string, unknown]> = []
		let scanned = 0
		for (const key in attrs) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(attrs, key)
			if (!descriptor) break
			if (++scanned > 256) return undefined
			if (!descriptor?.enumerable) continue
			if (!('value' in descriptor)) return undefined
			containNativePromiseUnchecked(descriptor.value)
			entries[entries.length] = [key, descriptor.value]
		}
		return entries
	} catch { return undefined }
}

function trimOptionalWhitespace(value: string): string {
	return nativeReflectApply(nativeStringReplace, value, [/^[ \t]+|[ \t]+$/gu, '']) as string
}

function isValidBaggageProperty(rawProperty: string): boolean {
	const property = trimOptionalWhitespace(rawProperty)
	if (!property) return false
	const separator = nativeReflectApply(nativeStringIndexOf, property, ['=']) as number
	const key = trimOptionalWhitespace(separator < 0 ? property
		: nativeReflectApply(nativeStringSlice, property, [0, separator]) as string)
	if (!isValidBaggageKey(key)) return false
	if (separator < 0) return true
	return decodeBaggageValue(trimOptionalWhitespace(
		nativeReflectApply(nativeStringSlice, property, [separator + 1]) as string
	)) !== undefined
}

function decodeBaggageValue(value: string): string | undefined {
	const bytes: number[] = []
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!
		if (character === '%') {
			const encoded = nativeReflectApply(nativeStringSlice, value, [index + 1, index + 3]) as string
			if (!matches(PERCENT_BYTE, encoded)) return undefined
			bytes[bytes.length] = nativeNumberParseInt(encoded, 16)
			index += 2
			continue
		}
		const code = nativeReflectApply(nativeStringCharCodeAt, character, [0]) as number
		const allowed = code === 0x21 || (code >= 0x23 && code <= 0x2b) ||
			(code >= 0x2d && code <= 0x3a) || (code >= 0x3c && code <= 0x5b) ||
			(code >= 0x5d && code <= 0x7e)
		if (!allowed) return undefined
		bytes[bytes.length] = code
	}
	const encoded = new NativeUint8Array(bytes.length)
	for (let index = 0; index < bytes.length; index += 1) encoded[index] = bytes[index]!
	return nativeReflectApply(nativeTextDecoderDecode, baggageTextDecoder, [encoded]) as string
}

function isDangerousKey(key: string): boolean {
	return key === '__proto__' || key === 'prototype' || key === 'constructor'
}

/** Validate the W3C tracestate list grammar, uniqueness, and hard limits. */
export function isValidTraceState(value: unknown): value is string {
	containNativePromiseUnchecked(value)
	// A present tracestate field is a non-empty list. Absence is represented by
	// `undefined` at call sites, not by accepting an empty header value.
	if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
	const members = nativeReflectApply(nativeStringSplit, value, [',']) as string[]
	if (members.length > 32) return false
	const keys = new NativeSet<string>()
	for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
		const rawMember = members[memberIndex]!
		// Only SP and HTAB are valid optional whitespace around list members.
		const member = nativeReflectApply(nativeStringReplace, rawMember, [/^[ \t]+|[ \t]+$/gu, '']) as string
		if (member.length === 0) return false
		const separator = nativeReflectApply(nativeStringIndexOf, member, ['=']) as number
		if (separator <= 0 || separator !== nativeReflectApply(nativeStringLastIndexOf, member, ['='])) return false
		const key = nativeReflectApply(nativeStringSlice, member, [0, separator]) as string
		const memberValue = nativeReflectApply(nativeStringSlice, member, [separator + 1]) as string
		const simpleKey = matches(SIMPLE_TRACESTATE_KEY, key)
		const multiTenantKey = matches(MULTI_TENANT_TRACESTATE_KEY, key)
		if ((!simpleKey && !multiTenantKey) || hasNativeSet(keys, key)) return false
		if (memberValue.length === 0 || memberValue.length > 256 ||
			nativeReflectApply(nativeStringStartsWith, memberValue, [' ']) ||
			nativeReflectApply(nativeStringEndsWith, memberValue, [' '])) return false
		for (let index = 0; index < memberValue.length; index += 1) {
			const character = memberValue[index]!
			const code = nativeReflectApply(nativeStringCharCodeAt, memberValue, [index]) as number
			if (code < 0x20 || code > 0x7e || character === ',' || character === '=') return false
		}
		addNativeSet(keys, key)
	}
	return true
}
