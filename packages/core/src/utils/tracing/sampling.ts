/**
 * @file Head sampling for tracing (parent-based, probabilistic, rules-based).
 * Determines whether a span should be recorded and sampled.
 */

import type {LogAttributes} from '../../contracts/logging'
import type {SpanContext} from '../../contracts/tracing'
import {containNativePromiseUnchecked, isolateUnexpectedThenable} from '../../runtime/async/native-promise'
import {pushNativeArray} from '../../runtime/collections/native-collections'
import {hash32Hex} from '../../utils/hashing/stable-hash'
import {hasSafePrototypeChain, isProxyObject} from '../safe-object'

const nativeMathRandom = Math.random.bind(Math)
const nativeReflectApply = Reflect.apply
const nativeArrayIsArray = Array.isArray
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsInteger = Number.isInteger
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeNumberParseInt = Number.parseInt
const nativeObjectFreeze = Object.freeze
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectPrototype = Object.prototype
const nativeRegExpTest = RegExp.prototype.test
const nativeStringCharCodeAt = String.prototype.charCodeAt
const nativeStringSlice = String.prototype.slice
const NativeRegExp = RegExp
const nativeRegExpPrototype = RegExp.prototype
const VALID_TRACE_ID = new NativeRegExp('^[0-9a-f]{32}$', 'u')
const ZERO_TRACE_ID = new NativeRegExp('^0{32}$', 'u')
const BACKREFERENCE = new NativeRegExp('\\\\(?:[1-9]|k<)', 'u')

function safeRandomUnit(): number {
	try {
		const value = nativeMathRandom()
		return nativeNumberIsFinite(value) && value >= 0 && value <= 1 ? value : 0.5
	} catch { return 0.5 }
}

/**
 * Sampling decision: whether to record and sample a span.
 */
export type SamplingDecision = 'record-and-sample' | 'drop'

/**
 * Sampler interface for making sampling decisions.
 */
export interface Sampler {

	/**
	 * Decide whether to sample a span.
	 * @param ctx - Parent span context (if any)
	 * @param name - Span name
	 * @param attrs - Optional span attributes
	 * @returns Sampling decision
	 */
	decide(ctx: SpanContext | undefined, name: string, attrs?: LogAttributes): SamplingDecision
}

/**
 * Options for parent-based sampler.
 */
export interface ParentBasedSamplerOptions {

	/** Whether to respect parent's sampling decision */
	respectParent?: boolean
}

function containSamplingInvocation(ctx: unknown, name: unknown, attrs: unknown): void {
	containNativePromiseUnchecked(ctx)
	containNativePromiseUnchecked(name)
	containNativePromiseUnchecked(attrs)
	if (!attrs || typeof attrs !== 'object' || !hasSafePrototypeChain(attrs)) return
	try {
		let fields = 0
		for (const key in attrs) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(attrs, key)
			if (!descriptor) break
			if (++fields > 256) return
			if (descriptor && 'value' in descriptor) containNativePromiseUnchecked(descriptor.value)
		}
	} catch { /* Sampling must fail closed on uninspectable attributes. */ }
}

/**
 * Create a parent-based sampler.
 * If parent context exists and is sampled (traceFlags & 0x1), always sample.
 * Otherwise, delegates to a root sampler.
 * @param rootSampler - Sampler to use when no parent or parent not sampled
 * @param options - Sampler options
 * @returns Parent-based sampler
 */
export function createParentBasedSampler(
	rootSampler: Sampler,
	options: ParentBasedSamplerOptions = {}
): Sampler {
	if (isolateUnexpectedThenable(rootSampler) || isolateUnexpectedThenable(options)) {
		throw new TypeError('Parent-based sampler configuration must be synchronous')
	}
	const rootDecide = captureSamplerDecision(rootSampler)
	if (!rootDecide) throw new Error('Parent-based root sampler must provide a stable data-method decide()')
	const configuredRespectParent = readDataProperty(options, 'respectParent')
	if (configuredRespectParent !== undefined && typeof configuredRespectParent !== 'boolean') {
		throw new Error('Parent-based sampler respectParent must be a boolean')
	}
	const respectParent = configuredRespectParent !== false

	return {
		decide(ctx, name, attrs) {
			containSamplingInvocation(ctx, name, attrs)

			if (respectParent && ctx) {
				const traceFlags = readContextDataProperty(ctx, 'traceFlags')
				return typeof traceFlags === 'number' && nativeNumberIsInteger(traceFlags)
					&& traceFlags >= 0 && traceFlags <= 255 && (traceFlags & 0x1) !== 0
					? 'record-and-sample' : 'drop'
			}

			// No parent or parent not sampled: use root sampler
			return rootDecide(undefined, name, attrs)
		}
	}
}

/**
 * Options for probabilistic sampler.
 */
export interface ProbabilisticSamplerOptions {

	/** Sampling ratio (0.0 to 1.0) */
	ratio: number

	/** Optional seed for deterministic hashing */
	seed?: number
}

/**
 * Create a probabilistic sampler.
 * Uses deterministic hash of traceId to decide sampling.
 * @param options - Sampler options
 * @returns Probabilistic sampler
 */
export function createProbabilisticSampler(options: ProbabilisticSamplerOptions): Sampler {
	if (isolateUnexpectedThenable(options)) throw new TypeError('Sampling configuration must be synchronous')
	const ratio = readDataProperty(options, 'ratio')
	const seed = readDataProperty(options, 'seed')
	assertRatio(ratio, 'Sampling ratio')
	if (seed !== undefined && !nativeNumberIsSafeInteger(seed)) {
		throw new Error('Sampling seed must be a safe integer')
	}

	if (ratio <= 0) {
		return {decide: (ctx, name, attrs) => {
			containSamplingInvocation(ctx, name, attrs)
			return 'drop'
		}}
	}

	if (ratio >= 1) {
		return {decide: (ctx, name, attrs) => {
			containSamplingInvocation(ctx, name, attrs)
			return 'record-and-sample'
		}}
	}

	return {
		decide(ctx, name, attrs) {
			containSamplingInvocation(ctx, name, attrs)
			if (!isSafeSamplingName(name)) return 'drop'

			if (!ctx) {
				if (seed === undefined) return safeRandomUnit() < ratio ? 'record-and-sample' : 'drop'
				return hashRatio(`${seed}:${name}`) < ratio ? 'record-and-sample' : 'drop'
			}

			const traceId = readContextDataProperty(ctx, 'traceId')
			if (!isValidTraceId(traceId)) return 'drop'
			return hashRatio(seed === undefined ? traceId : `${seed}:${traceId}`) < ratio
				? 'record-and-sample' : 'drop'
		}
	}
}

/**
 * Options for rules-based sampler.
 */
export interface RulesBasedSamplerOptions {

	/** Rules: array of {pattern, ratio} */
	rules: ReadonlyArray<{
		pattern: RegExp | string
		ratio: number
	}>

	/** Default ratio if no rules match */
	defaultRatio: number
}

/**
 * Create a rules-based sampler.
 * Matches span name against patterns and uses corresponding ratio.
 * @param options - Sampler options
 * @returns Rules-based sampler
 */
export function createRulesBasedSampler(options: RulesBasedSamplerOptions): Sampler {
	if (isolateUnexpectedThenable(options)) throw new TypeError('Sampling configuration must be synchronous')
	const rules = readDataProperty(options, 'rules')
	if (isolateUnexpectedThenable(rules)) throw new TypeError('Sampling rules must be synchronous')
	const defaultRatio = readDataProperty(options, 'defaultRatio')
	assertRatio(defaultRatio, 'Default sampling ratio')
	if (!nativeArrayIsArray(rules)) {
		throw new Error('Sampling rules must be an array with at most 1000 entries')
	}
	const length = readDataProperty(rules, 'length')
	if (!nativeNumberIsSafeInteger(length) || (length as number) < 0 || (length as number) > 1_000) {
		throw new Error('Sampling rules must be an array with at most 1000 entries')
	}
	const compiledRules: Array<{pattern: RegExp; ratio: number}> = []
	for (let index = 0; index < (length as number); index += 1) {
		const descriptor = safeOwnDescriptor(rules, index)
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new Error('Sampling rules must be a dense data array')
		}
		containNativePromiseUnchecked(descriptor.value)
		const rule = descriptor.value
		if (!rule || typeof rule !== 'object' || nativeArrayIsArray(rule)) {
			throw new Error(`Sampling rule ${index} must be a data object`)
		}
		const ratio = readDataProperty(rule, 'ratio')
		const rawPattern = readDataProperty(rule, 'pattern')
		assertRatio(ratio, `Sampling rule ${index} ratio`)
		pushNativeArray(compiledRules, nativeObjectFreeze({pattern: compileSafePattern(rawPattern, index), ratio}))
	}
	nativeObjectFreeze(compiledRules)

	return {
		decide(ctx, name, attrs) {
			containSamplingInvocation(ctx, name, attrs)
			if (!isSafeSamplingName(name)) return 'drop'
			const traceId = ctx ? readContextDataProperty(ctx, 'traceId') : undefined
			if (ctx && !isValidTraceId(traceId)) return 'drop'

			// Find matching rule
			for (let index = 0; index < compiledRules.length; index += 1) {
				const rule = compiledRules[index]!
				if (nativeReflectApply(nativeRegExpTest, rule.pattern, [name]) as boolean) {
					// Use this rule's ratio
					const hashValue = hashRatio(ctx ? traceId as string : name + safeRandomUnit())
					return hashValue < rule.ratio ? 'record-and-sample' : 'drop'
				}
			}

			// No rule matched: use default ratio
			const hashValue = hashRatio(ctx ? traceId as string : name + safeRandomUnit())
			return hashValue < defaultRatio ? 'record-and-sample' : 'drop'
		}
	}
}

function assertRatio(ratio: unknown, label: string): asserts ratio is number {
	if (typeof ratio !== 'number' || !nativeNumberIsFinite(ratio) || ratio < 0 || ratio > 1) {
		throw new Error(`${label} must be between 0 and 1`)
	}
}

function safeOwnDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
	if (isProxyObject(value)) return undefined
	try { return nativeObjectGetOwnPropertyDescriptor(value, key) } catch { return undefined }
}

function captureSamplerDecision(sampler: unknown): Sampler['decide'] | undefined {
	if (!sampler || (typeof sampler !== 'object' && typeof sampler !== 'function')) return undefined
	if (isProxyObject(sampler)) return undefined
	let current: object | null = sampler as object
	try {
		for (let depth = 0; current && current !== nativeObjectPrototype && depth < 16; depth += 1) {
			if (isProxyObject(current)) return undefined
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, 'decide')
			if (descriptor) {
				if ('value' in descriptor) containNativePromiseUnchecked(descriptor.value)
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as Sampler['decide']
				return (ctx, name, attrs) => {
					containSamplingInvocation(ctx, name, attrs)
					try {
						const decision = nativeReflectApply(method, sampler, [ctx, name, attrs])
						if (isolateUnexpectedThenable(decision)) return 'drop'
						return decision === 'record-and-sample' ? decision : 'drop'
					} catch(error) { containNativePromiseUnchecked(error); return 'drop' }
				}
			}
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function readDataProperty(value: unknown, key: PropertyKey): unknown {
	containNativePromiseUnchecked(value)
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	const descriptor = safeOwnDescriptor(value, key)
	if (!descriptor) return undefined
	if (!('value' in descriptor)) throw new Error('Sampling configuration and context must use data properties')
	containNativePromiseUnchecked(descriptor.value)
	return descriptor.value
}

function readContextDataProperty(value: unknown, key: PropertyKey): unknown {
	try { return readDataProperty(value, key) }
	catch(error) {
		containNativePromiseUnchecked(error)
		// Runtime propagation data is not trusted configuration. Sampling must fail
		// closed instead of allowing an accessor-backed context to escape the hot path.
		return undefined
	}
}

function isSafeSamplingName(value: unknown): value is string {
	containNativePromiseUnchecked(value)
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
	for (let index = 0; index < value.length; index += 1) {
		const code = nativeReflectApply(nativeStringCharCodeAt, value, [index]) as number
		if (code <= 31 || code === 127) return false
	}
	return true
}

function isValidTraceId(value: unknown): value is string {
	return typeof value === 'string'
		&& nativeReflectApply(nativeRegExpTest, VALID_TRACE_ID, [value]) as boolean
		&& !(nativeReflectApply(nativeRegExpTest, ZERO_TRACE_ID, [value]) as boolean)
}

function compileSafePattern(value: unknown, index: number): RegExp {
	let source: string
	let flags = ''
	if (typeof value === 'string') source = value
	else if (value && typeof value === 'object') {
		try {
			const readNative = (property: string): unknown => {
				const getter = nativeObjectGetOwnPropertyDescriptor(nativeRegExpPrototype, property)?.get
				return getter ? nativeReflectApply(getter, value, []) : undefined
			}
			const nativeSource = readNative('source')
			if (typeof nativeSource !== 'string') throw new TypeError()
			source = nativeSource
			if (readNative('hasIndices') === true) flags += 'd'
			if (readNative('ignoreCase') === true) flags += 'i'
			if (readNative('multiline') === true) flags += 'm'
			if (readNative('dotAll') === true) flags += 's'
			if (readNative('unicode') === true) flags += 'u'
			if (readNative('unicodeSets') === true) flags += 'v'
		} catch { throw new Error(`Sampling rule ${index} pattern must be a string or RegExp`) }
	} else throw new Error(`Sampling rule ${index} pattern must be a string or RegExp`)

	validateLinearPattern(source, index)
	try { return new NativeRegExp(source, flags) } catch {
		throw new Error(`Sampling rule ${index} pattern is invalid`)
	}
}

/** JavaScript has no synchronous RegExp execution deadline. Keep configured
 * matchers repetition-free so span names cannot trigger catastrophic backtracking. */
function validateLinearPattern(source: string, index: number): void {
	if (source.length > 256) throw new Error(`Sampling rule ${index} pattern must contain at most 256 characters`)
	let escaped = false
	let inCharacterClass = false
	for (let cursor = 0; cursor < source.length; cursor += 1) {
		const character = source[cursor]!
		if (escaped) { escaped = false; continue }
		if (character === '\\') { escaped = true; continue }
		if (character === '[') { inCharacterClass = true; continue }
		if (character === ']' && inCharacterClass) { inCharacterClass = false; continue }
		if (!inCharacterClass && (character === '*' || character === '+' || character === '?' || character === '{')) {
			throw new Error(`Sampling rule ${index} pattern must not contain repetition or lookaround constructs`)
		}
	}
	if (escaped || inCharacterClass || nativeReflectApply(nativeRegExpTest, BACKREFERENCE, [source]) as boolean) {
		throw new Error(`Sampling rule ${index} pattern is not a bounded matcher`)
	}
}

function hashRatio(value: string): number {
	const hash = hash32Hex(value)
	// Map every uint32 into [0, 1). Dividing by UINT32_MAX incorrectly maps
	// 0xffffffff to exactly 1, making a ratio of 1 drop a deterministic subset.
	return nativeNumberParseInt(
		nativeReflectApply(nativeStringSlice, hash, [0, 8]) as string, 16
	) / 0x1_0000_0000
}

/**
 * Create a sampler that always samples.
 * @returns Always-sample sampler
 */
export function createAlwaysOnSampler(): Sampler {

	return {
		decide: (ctx, name, attrs) => {
			containSamplingInvocation(ctx, name, attrs)
			return 'record-and-sample'
		}
	}
}

/**
 * Create a sampler that never samples.
 * @returns Never-sample sampler
 */
export function createAlwaysOffSampler(): Sampler {

	return {
		decide: (ctx, name, attrs) => {
			containSamplingInvocation(ctx, name, attrs)
			return 'drop'
		}
	}
}
