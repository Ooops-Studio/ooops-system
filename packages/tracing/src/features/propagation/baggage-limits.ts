/**
 * @file Baggage propagation limits and safety.
 * Enforces maximum baggage byte size and key count to prevent header bloat.
 */
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'
import {isValidBaggageKey} from '@ooopsstudio/core/utils/tracing'

import {MAX_BAGGAGE_BYTES, MAX_BAGGAGE_KEYS} from '../../constants'
import {snapshotDataFields} from '../../utils/capabilities'
/**
 * Options for baggage limits.
 */
export interface BaggageLimitsOptions {
	/** Maximum baggage byte size (default: MAX_BAGGAGE_BYTES) */
	maxBytes?: number
	/** Maximum baggage keys (default: MAX_BAGGAGE_KEYS) */
	maxKeys?: number
}
function resolveLimits(options: BaggageLimitsOptions): {maxBytes: number; maxKeys: number} {
	let snapshot: Readonly<Record<string, unknown>>
	try { snapshot = snapshotDataFields(options, 2, 32, new Set(['maxBytes', 'maxKeys'])) }
	catch { throw new TypeError('Baggage limits options must be a closed plain data object') }
	const configured = snapshot as BaggageLimitsOptions
	const maxBytes = configured.maxBytes ?? MAX_BAGGAGE_BYTES
	const maxKeys = configured.maxKeys ?? MAX_BAGGAGE_KEYS
	if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
		throw new Error('Baggage maxBytes must be a positive integer')
	}
	if (maxBytes > 1_000_000) throw new Error('Baggage maxBytes must be at most 1000000')
	if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
		throw new Error('Baggage maxKeys must be a positive integer')
	}
	if (maxKeys > 10_000) throw new Error('Baggage maxKeys must be at most 10000')
	return {maxBytes, maxKeys}
}
/**
 * Apply baggage limits to attributes.
 * Truncates or drops attributes if limits are exceeded.
 * @param attrs - Baggage attributes
 * @param options - Limit options
 * @returns Filtered attributes within limits
 */
export function applyBaggageLimits(
	attrs: LogAttributes,
	options: BaggageLimitsOptions = {}
): LogAttributes {
	const {maxBytes, maxKeys} = resolveLimits(options)
	const result: Record<string, unknown> = {}
	let totalBytes = 0
	let keyCount = 0
	const snapshot = readBaggageEntries(attrs, maxKeys)
	if (!snapshot) return result as LogAttributes
	for (const [key, value] of snapshot.entries) {
		if (key.length > maxBytes || !isValidBaggageKey(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') continue
		// Check key count limit
		if (keyCount >= maxKeys) {
			break
		}
		// Estimate value size
		const valueStr = baggageValueToString(value)
		if (valueStr === undefined) continue
		const keySize = byteSize(key)
		let encodedValue: string | undefined
		let valueSize = maxBytes + 1
		try {
			// Raw UTF-8 size is a lower bound for percent-encoded size. Avoid
			// allocating a many-megabyte encoded string when it cannot fit.
			// UTF-8 bytes are never fewer than UTF-16 code units. Reject an
			// impossible-to-fit value by length before TextEncoder or percent
			// encoding can allocate in proportion to an unbounded caller string.
			if (valueStr.length <= maxBytes && byteSize(valueStr) <= maxBytes) {
				encodedValue = encodeURIComponent(valueStr)
				valueSize = byteSize(encodedValue)
			}
		} catch { continue }
		const entrySize = keySize + valueSize + 2 // +2 for '=' and separator
		// Check byte limit
		if (totalBytes + entrySize > maxBytes) {
			// Try to truncate value if it's a string
			if (typeof value === 'string' && value.length > 0) {
				const availableBytes = maxBytes - totalBytes - keySize - 2
				const suffix = '[TRUNCATED]'
				const truncateOverhead = byteSize(encodeURIComponent(suffix))
				const maxValueBytes = Math.max(
					0,
					availableBytes - truncateOverhead
				)
				if (maxValueBytes > 0) {
					const prefixCharacters: string[] = []
					let prefixBytes = 0
					for (const character of value) {
						let characterBytes: number
						try { characterBytes = byteSize(encodeURIComponent(character)) } catch { break }
						if (prefixBytes + characterBytes > maxValueBytes) break
						prefixCharacters.push(character)
						prefixBytes += characterBytes
					}
					const prefix = prefixCharacters.join('')
					if (prefix.length > 0) {
						const truncated = prefix + suffix
						result[key] = truncated
						totalBytes += keySize + byteSize(encodeURIComponent(truncated)) + 2
						keyCount++
					}
				}
			}
			// If can't fit even truncated, skip this key but continue with others
			continue
		}
		// Safe to add
		/* v8 ignore next -- assigned whenever the value fits */
		result[key] = valueStr
		totalBytes += entrySize
		keyCount++
	}
	return result as LogAttributes
}
/**
 * Check if baggage attributes exceed limits.
 * @param attrs - Baggage attributes
 * @param options - Limit options
 * @returns True if limits are exceeded
 */
export function exceedsBaggageLimits(
	attrs: LogAttributes,
	options: BaggageLimitsOptions = {}
): boolean {
	const {maxBytes, maxKeys} = resolveLimits(options)
	const snapshot = readBaggageEntries(attrs, maxKeys)
	if (!snapshot || snapshot.truncated || snapshot.entries.length > maxKeys) {
		return true
	}
	// Estimate total size
	let totalBytes = 0
	for (const [key, value] of snapshot.entries) {
		if (key.length > maxBytes || !isValidBaggageKey(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') return true
		const valueString = baggageValueToString(value)
		if (valueString === undefined) return true
		if (valueString.length > maxBytes) return true
		let encoded: string
		try { encoded = encodeURIComponent(valueString) } catch { return true }
		totalBytes += byteSize(key) + byteSize(encoded) + 2
		if (totalBytes > maxBytes) {
			return true
		}
	}
	return false
}

function baggageValueToString(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	if (typeof value === 'number') return Number.isFinite(value) ? `${value}` : undefined
	if (value === null) return 'null'
	return undefined
}

function readBaggageEntries(
	attrs: LogAttributes,
	maxKeys: number
): {entries: Array<[string, unknown]>; truncated: boolean} | undefined {
	try {
		if (!isPlainObject(attrs)) return undefined
		const entries: Array<[string, unknown]> = []
		const maxScannedFields = Math.max(256, Math.min(40_000, maxKeys * 4))
		let scanned = 0
		for (const key in attrs) {
			if (++scanned > maxScannedFields) return {entries, truncated: true}
			if (key.length > MAX_BAGGAGE_BYTES || !Object.hasOwn(attrs, key)) continue
			const descriptor = Object.getOwnPropertyDescriptor(attrs, key)
			if (!descriptor?.enumerable) continue
			// Baggage is a data boundary. Accessor-backed values could execute
			// caller code during propagation, so reject the whole container.
			if (!('value' in descriptor)) return undefined
			entries.push([key, descriptor.value])
		}
		return {entries, truncated: false}
	} catch {
		return undefined
	}
}
