/**
 * @file Validation utilities for configuration and runtime checks.
 * Common validation functions used across services.
 */

import {containNativePromiseUnchecked} from '../runtime/async/native-promise'
import {hasNativeSet, pushNativeArray, sizeNativeSet} from '../runtime/collections/native-collections'

import {byteSize} from './byte-size'
import {isProxyObject} from './safe-object'
/**
 * Validation error with human-readable message
 */
export class ConfigValidationError extends Error {
	constructor(message: string) {
		containNativePromiseUnchecked(message)
		super(typeof message === 'string' && message.length <= 4_096
			? message : 'Invalid configuration')
		this.name = 'ConfigValidationError'
	}
}

const MAX_VALIDATION_URL_LENGTH = 4_096
const MAX_VALIDATION_HEADER_COUNT = 256
const MAX_VALIDATION_HEADER_KEY_LENGTH = 256
const MAX_VALIDATION_HEADER_VALUE_LENGTH = 8_192
const MAX_SNAPSHOT_FIELDS = 1_024
const NativeURL = URL
const nativeReflectApply = Reflect.apply
const nativeRegExpTest = RegExp.prototype.test
const nativeStringIncludes = String.prototype.includes
const nativeStringSlice = String.prototype.slice
const nativeArrayIsArray = Array.isArray
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsInteger = Number.isInteger
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectCreate = Object.create
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectHasOwn = Object.hasOwn
const nativeObjectPrototype = Object.prototype
const VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u

function safeValidationName(value: unknown): string {
	containNativePromiseUnchecked(value)
	return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : 'value'
}

function describeValidationValue(value: unknown): string {
	containNativePromiseUnchecked(value)
	if (value === null) return 'null'
	if (typeof value === 'string') return value.length <= 128 ? value
		: `${nativeReflectApply(nativeStringSlice, value, [0, 128]) as string}…`
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') return `${value}`
	if (typeof value === 'bigint') return 'bigint'
	if (typeof value === 'symbol') return 'symbol'
	if (typeof value === 'function') return 'function'
	return 'object'
}

/**
 * Validate that a value is a positive finite number
 * @param value - Value to validate
 * @param name - Name of the value for error messages
 * @throws ConfigValidationError if validation fails
 */
export function validatePositiveFinite(value: unknown, name: string): asserts value is number {
	name = safeValidationName(name)
	if (typeof value !== 'number' || !nativeNumberIsFinite(value) || value <= 0) {
		throw new ConfigValidationError(`${name} must be a positive finite number, got: ${describeValidationValue(value)}`)
	}
}

/**
 * Validate that a value is a non-negative finite number
 * @param value - Value to validate
 * @param name - Name of the value for error messages
 * @throws ConfigValidationError if validation fails
 */
export function validateNonNegativeFinite(value: unknown, name: string): asserts value is number {
	name = safeValidationName(name)
	if (typeof value !== 'number' || !nativeNumberIsFinite(value) || value < 0) {
		throw new ConfigValidationError(`${name} must be a non-negative finite number, got: ${describeValidationValue(value)}`)
	}
}

/**
 * Validate that a value is a positive integer
 * @param value - Value to validate
 * @param name - Name of the value for error messages
 * @throws ConfigValidationError if validation fails
 */
export function validatePositiveInteger(value: unknown, name: string): asserts value is number {
	name = safeValidationName(name)
	if (!nativeNumberIsInteger(value) || (value as number) < 1) {
		throw new ConfigValidationError(`${name} must be a positive integer, got: ${describeValidationValue(value)}`)
	}
}

/**
 * Validate that a value is a non-negative integer
 * @param value - Value to validate
 * @param name - Name of the value for error messages
 * @throws ConfigValidationError if validation fails
 */
export function validateNonNegativeInteger(value: unknown, name: string): asserts value is number {
	name = safeValidationName(name)
	if (!nativeNumberIsInteger(value) || (value as number) < 0) {
		throw new ConfigValidationError(`${name} must be a non-negative integer, got: ${describeValidationValue(value)}`)
	}
}

/**
 * Validate that a value is a finite number
 * @param value - Value to validate
 * @param name - Name of the value for error messages
 * @throws ConfigValidationError if validation fails
 */
export function validateFiniteNumber(value: unknown, name: string): asserts value is number {
	name = safeValidationName(name)
	if (typeof value !== 'number' || !nativeNumberIsFinite(value)) {
		throw new ConfigValidationError(`${name} must be a finite number, got: ${describeValidationValue(value)}`)
	}
}

/**
 * Validate that a value is a number within a range (inclusive)
 * @param value - Value to validate
 * @param name - Name of the value for error messages
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @throws ConfigValidationError if validation fails
 */
export function validateNumberInRange(
	value: unknown,
	name: string,
	min: number,
	max: number
): asserts value is number {
	containNativePromiseUnchecked(min)
	containNativePromiseUnchecked(max)
	name = safeValidationName(name)
	if (typeof min !== 'number' || !nativeNumberIsFinite(min)
		|| typeof max !== 'number' || !nativeNumberIsFinite(max) || min > max) {
		throw new ConfigValidationError(`${name} range bounds must be finite numbers with min no greater than max`)
	}
	validateFiniteNumber(value, name)
	if ((value as number) < min || (value as number) > max) {
		throw new ConfigValidationError(`${name} must be between ${min} and ${max} (inclusive), got: ${value}`)
	}
}

/**
 * Validate URL format
 * @param url - URL string to validate
 * @param name - Name of the URL for error messages
 * @throws ConfigValidationError if validation fails
 */
export function validateUrl(url: string, name: string): void {
	containNativePromiseUnchecked(url)
	name = safeValidationName(name)
	if (typeof url !== 'string' || url.length === 0 || url.length > MAX_VALIDATION_URL_LENGTH) {
		throw new ConfigValidationError(
			`${name} must be a non-empty URL string of at most ${MAX_VALIDATION_URL_LENGTH} characters`
		)
	}

	try {

		new NativeURL(url)
	} catch {
		throw new ConfigValidationError(
			`${name} must be a valid URL`
		)
	}
}

/**
 * Validate headers object
 * @param headers - Headers object to validate
 * @throws ConfigValidationError if validation fails
 */
export function validateHeaders(headers: Record<string, string>): void {
	containNativePromiseUnchecked(headers)

	if (!headers || typeof headers !== 'object' || nativeArrayIsArray(headers)) {
		throw new ConfigValidationError(
			'Headers must be a plain object, got ' + typeof headers
		)
	}
	try {
		if (isProxyObject(headers)) throw new Error('invalid headers')
		const prototype = nativeObjectGetPrototypeOf(headers)
		if (prototype !== nativeObjectPrototype && prototype !== null) throw new Error('invalid headers')
		let fields = 0
		let scanned = 0
		for (const key in headers) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(headers, key)
			if (!descriptor) break
			if (++scanned > MAX_VALIDATION_HEADER_COUNT) throw new Error('invalid headers')
			if ('value' in descriptor) containNativePromiseUnchecked(descriptor.value)
			if (++fields > MAX_VALIDATION_HEADER_COUNT) throw new Error('invalid headers')
			if (!descriptor?.enumerable || !('value' in descriptor)
				|| key.length === 0 || key.length > MAX_VALIDATION_HEADER_KEY_LENGTH
				|| !(nativeReflectApply(nativeRegExpTest, VALID_HEADER_NAME, [key]) as boolean)
				|| typeof descriptor.value !== 'string'
				|| descriptor.value.length > MAX_VALIDATION_HEADER_VALUE_LENGTH
				|| byteSize(descriptor.value) > MAX_VALIDATION_HEADER_VALUE_LENGTH
				|| nativeReflectApply(nativeStringIncludes, descriptor.value, ['\0']) as boolean
				|| nativeReflectApply(nativeStringIncludes, descriptor.value, ['\r']) as boolean
				|| nativeReflectApply(nativeStringIncludes, descriptor.value, ['\n']) as boolean) {
				throw new Error('invalid headers')
			}
		}
	} catch {
		throw new ConfigValidationError(
			`Headers must contain at most ${MAX_VALIDATION_HEADER_COUNT} bounded string data properties`
		)
	}
}

/** Snapshot a bounded dense array without invoking element accessors. */
export function snapshotDenseDataArray(value: unknown, maximumLength: number): unknown[] | undefined {
	containNativePromiseUnchecked(value)
	containNativePromiseUnchecked(maximumLength)
	if (isProxyObject(value) || !nativeArrayIsArray(value)
		|| !nativeNumberIsSafeInteger(maximumLength) || maximumLength < 0) return undefined
	try {
		const lengthDescriptor = nativeObjectGetOwnPropertyDescriptor(value, 'length')
		const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
		if (!nativeNumberIsSafeInteger(length) || length < 0 || length > maximumLength) return undefined
		const result: unknown[] = []
		for (let index = 0; index < length; index++) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(value, index)
			if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
			containNativePromiseUnchecked(descriptor.value)
			pushNativeArray(result, descriptor.value)
		}
		return result
	} catch { return undefined }
}

/** Snapshot a plain object containing only enumerable data properties. */
export function snapshotPlainDataRecord(
	value: unknown,
	allowedFields: ReadonlySet<string>,
	requiredFields: readonly string[] = []
): Record<string, unknown> | undefined {
	containNativePromiseUnchecked(value)
	containNativePromiseUnchecked(allowedFields)
	containNativePromiseUnchecked(requiredFields)
	if (!value || typeof value !== 'object' || nativeArrayIsArray(value)) return undefined
	try {
		if (isProxyObject(value)) return undefined
		if (isProxyObject(allowedFields) || isProxyObject(requiredFields)
			|| !nativeArrayIsArray(requiredFields)) return undefined
		const allowedCount = sizeNativeSet(allowedFields as Set<string>)
		if (!nativeNumberIsSafeInteger(allowedCount) || allowedCount < 0
			|| allowedCount > MAX_SNAPSHOT_FIELDS) return undefined
		const requiredLength = nativeObjectGetOwnPropertyDescriptor(requiredFields, 'length')?.value as unknown
		if (!nativeNumberIsSafeInteger(requiredLength) || (requiredLength as number) < 0
			|| (requiredLength as number) > allowedCount) return undefined
		const prototype = nativeObjectGetPrototypeOf(value)
		if (prototype !== nativeObjectPrototype && prototype !== null) return undefined
		const snapshot = nativeObjectCreate(null) as Record<string, unknown>
		let fields = 0
		let scanned = 0
		for (const key in value) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
			if (!descriptor) break
			if (++scanned > allowedCount) return undefined
			if (++fields > allowedCount || !hasNativeSet(allowedFields as Set<string>, key)) return undefined
			if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
			containNativePromiseUnchecked(descriptor.value)
			snapshot[key] = descriptor.value
		}
		for (let index = 0; index < (requiredLength as number); index += 1) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(requiredFields, index)
			if (descriptor && 'value' in descriptor) containNativePromiseUnchecked(descriptor.value)
			if (!descriptor?.enumerable || !('value' in descriptor)
				|| typeof descriptor.value !== 'string' || !nativeObjectHasOwn(snapshot, descriptor.value)) return undefined
		}
		return snapshot
	} catch { return undefined }
}
