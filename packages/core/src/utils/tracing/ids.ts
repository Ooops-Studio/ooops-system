/**
 * @file ID generation for tracing (128-bit trace IDs, 64-bit span IDs).
 * Cryptographically strong randomness with deterministic option for testing.
 */

import {Buffer} from 'node:buffer'
import {randomBytes} from 'node:crypto'

import {
	containNativePromiseUnchecked,
	isolateUnexpectedThenable
} from '../../runtime/async/native-promise'
import {isProxyObject} from '../safe-object'

const nativeReflectApply = Reflect.apply
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeRegExpTest = RegExp.prototype.test
const nativeBufferAllocUnsafe = Buffer.allocUnsafe
const nativeBufferToString = Buffer.prototype.toString
const nativeBufferWriteBigUInt64BE = Buffer.prototype.writeBigUInt64BE
const NativeBigInt = BigInt
const ALL_ZERO_ID = /^0+$/u

/**
 * Options for creating ID generators.
 */
export interface IdGeneratorOptions {

	/** Use deterministic (seeded) generator for testing */
	deterministic?: boolean

	/** Seed for deterministic generator (only used if deterministic=true) */
	seed?: number
}

/**
 * ID generator interface.
 */
export interface IdGenerator {

	/** Generate a 128-bit trace ID (32-character hex string) */
	nextTraceId(): string

	/** Generate a 64-bit span ID (16-character hex string) */
	nextSpanId(): string
}

function readIdOption(options: unknown, key: keyof IdGeneratorOptions): unknown {
	containNativePromiseUnchecked(options)
	if (!options || typeof options !== 'object') return undefined
	if (isProxyObject(options)) throw new TypeError('Tracing ID options must not be a Proxy')
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(options, key)
		if (!descriptor) return undefined
		if (!('value' in descriptor)) throw new TypeError('Tracing ID options must use data properties')
		containNativePromiseUnchecked(descriptor.value)
		return descriptor.value
	} catch(error) {
		if (error instanceof TypeError) throw error
		throw new TypeError('Tracing ID options cannot be inspected safely')
	}
}

/**
 * Create a cryptographically strong ID generator.
 * @returns ID generator
 */
function createTraceIdGenerator(): () => string {

	return () => {
		return createNonZeroRandomId(16)
	}
}

/**
 * Create a cryptographically strong span ID generator.
 * @returns Span ID generator
 */
function createSpanIdGenerator(): () => string {

	return () => {
		return createNonZeroRandomId(8)
	}
}

function createNonZeroRandomId(bytes: number): string {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const id = nativeReflectApply(nativeBufferToString, randomBytes(bytes), ['hex']) as string
		if (!(nativeReflectApply(nativeRegExpTest, ALL_ZERO_ID, [id]) as boolean)) return id
	}
	throw new Error('Cryptographic random source repeatedly returned an invalid all-zero identifier')
}

/**
 * Create a deterministic ID generator for testing.
 * Uses a simple counter-based approach with a seed.
 * @param seed - Initial seed value
 * @returns Deterministic ID generator
 */
function createDeterministicTraceIdGenerator(seed = 0): () => string {

	let counter = nativeReflectApply(NativeBigInt, undefined, [seed]) as bigint
	counter += 1n

	return () => {
		const buffer = nativeReflectApply(nativeBufferAllocUnsafe, Buffer, [16]) as Buffer
		nativeReflectApply(nativeBufferWriteBigUInt64BE, buffer, [counter & 0xffffffffffffffffn, 0])
		nativeReflectApply(nativeBufferWriteBigUInt64BE, buffer, [(counter * 0x9e3779b9n) & 0xffffffffffffffffn, 8])
		counter++
		return nativeReflectApply(nativeBufferToString, buffer, ['hex']) as string
	}
}

/**
 * Create a deterministic span ID generator for testing.
 * @param seed - Initial seed value
 * @returns Deterministic span ID generator
 */
function createDeterministicSpanIdGenerator(seed = 0): () => string {

	let counter = nativeReflectApply(NativeBigInt, undefined, [seed]) as bigint
	counter += 1n

	return () => {
		// Generate deterministic span ID from counter
		const buffer = nativeReflectApply(nativeBufferAllocUnsafe, Buffer, [8]) as Buffer
		nativeReflectApply(nativeBufferWriteBigUInt64BE, buffer, [counter & 0xffffffffffffffffn, 0])
		counter++
		return nativeReflectApply(nativeBufferToString, buffer, ['hex']) as string
	}
}

/**
 * Create a complete ID generator (trace + span).
 * @param options - Generator options
 * @returns ID generator
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
	if (isolateUnexpectedThenable(options)) {
		throw new TypeError('Tracing ID options must be a synchronous configuration object')
	}
	const deterministic = readIdOption(options, 'deterministic')
	const configuredSeed = readIdOption(options, 'seed')
	if (deterministic !== undefined && typeof deterministic !== 'boolean') {
		throw new TypeError('Tracing ID deterministic option must be a boolean')
	}
	if (deterministic === true) {
		const seed = configuredSeed ?? 0
		if (typeof seed !== 'number' || !nativeNumberIsSafeInteger(seed) || seed < 0) {
			throw new Error('Tracing ID seed must be a non-negative safe integer')
		}
		return {
			nextTraceId: createDeterministicTraceIdGenerator(seed),
			nextSpanId: createDeterministicSpanIdGenerator(seed)
		}
	}

	return {
		nextTraceId: createTraceIdGenerator(),
		nextSpanId: createSpanIdGenerator()
	}
}
