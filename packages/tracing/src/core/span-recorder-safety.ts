import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanContext} from '@ooopsstudio/core/contracts/tracing'
import {byteSize} from '@ooopsstudio/core/utils/byte-size'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'
import {isValidTraceState} from '@ooopsstudio/core/utils/tracing'

export function isSafeSpanText(value: unknown, maxLength: number): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code <= 31 || code === 127) return false
	}
	return true
}

export function isValidSpanContext(context: SpanContext): boolean {
	return snapshotSpanContext(context) !== undefined
}

export function snapshotSpanContext(context: SpanContext): SpanContext | undefined {
	try {
		if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined
		const read = (key: keyof SpanContext): unknown => {
			const descriptor = Object.getOwnPropertyDescriptor(context, key)
			if (!descriptor) return undefined
			if (!('value' in descriptor)) throw new TypeError('accessor-backed span context')
			return descriptor.value
		}
		const traceId = read('traceId')
		const spanId = read('spanId')
		const parentSpanId = read('parentSpanId')
		const traceFlags = read('traceFlags')
		const traceState = read('traceState')
		if (typeof traceId !== 'string' || !/^[0-9a-f]{32}$/u.test(traceId) || /^0{32}$/u.test(traceId)) return undefined
		if (typeof spanId !== 'string' || !/^[0-9a-f]{16}$/u.test(spanId) || /^0{16}$/u.test(spanId)) return undefined
		if (parentSpanId !== undefined && (
			typeof parentSpanId !== 'string' || !/^[0-9a-f]{16}$/u.test(parentSpanId) || /^0{16}$/u.test(parentSpanId)
		)) return undefined
		if (traceFlags !== undefined && (
			typeof traceFlags !== 'number' || !Number.isInteger(traceFlags) || traceFlags < 0 || traceFlags > 255
		)) return undefined
		if (traceState !== undefined && !isValidTraceState(traceState)) return undefined
		return {
			traceId,
			spanId,
			...(parentSpanId !== undefined ? {parentSpanId} : {}),
			...(traceFlags !== undefined ? {traceFlags} : {}),
			...(traceState !== undefined ? {traceState} : {})
		}
	} catch { return undefined }
}

export function snapshotSpanValue(value: unknown, maxStringLength = 16_000): unknown {
	return snapshotSpanValueWithState(value, maxStringLength, {
		ancestors: new Set<object>(),
		nodes: 0,
		stringUnits: 0
	})
}

export function snapshotSpanAttributes(attributes: LogAttributes, maxKeys = 64, maxBytes = 16_000): LogAttributes | undefined {
	return snapshotSpanAttributesDetailed(attributes, maxKeys, maxBytes).attributes
}

export function snapshotSpanAttributesDetailed(
	attributes: LogAttributes,
	maxKeys = 64,
	maxBytes = 16_000
): {attributes: LogAttributes | undefined; droppedCount: number} {
	try {
		const result: Record<string, unknown> = {}
		let count = 0
		let scanned = 0
		let droppedCount = 0
		let totalBytes = 2
		// One adversarial container must not receive a fresh recursive traversal
		// budget for every field it exposes.
		const valueSnapshotState = {ancestors: new Set<object>(), nodes: 0, stringUnits: 0}
		if (!isPlainObject(attributes)) throw new TypeError()
		const maxScannedFields = Math.max(256, Math.min(40_000, maxKeys * 4))
		// Enumerate lazily and inspect one descriptor at a time. Materializing every
		// descriptor before applying maxKeys lets a very wide JSON object multiply
		// memory even though almost all of its fields will be dropped.
		for (const key in attributes) {
			if (++scanned > maxScannedFields) { droppedCount++; break }
			if (!isSafeSpanText(key, 256)) { droppedCount++; continue }
			if (!Object.hasOwn(attributes, key)) continue
			const descriptor = Object.getOwnPropertyDescriptor(attributes, key)
			if (!descriptor?.enumerable) continue
			if (count >= maxKeys || key === '__proto__' || key === 'prototype' || key === 'constructor' || !('value' in descriptor)) {
				droppedCount++
				continue
			}
			// Each top-level attribute receives the configured value budget. The
			// node counter remains shared so many fields cannot reset graph traversal.
			valueSnapshotState.stringUnits = 0
			const snapshot = snapshotSpanValueWithState(descriptor.value, maxBytes, valueSnapshotState)
			if (snapshot === undefined) { droppedCount++; continue }
			const serialized = JSON.stringify(snapshot)
			if (serialized === undefined) { droppedCount++; continue }
			const entryBytes = byteSize(JSON.stringify(key)) + 1 + byteSize(serialized) + (count > 0 ? 1 : 0)
			if (totalBytes + entryBytes > maxBytes) { droppedCount++; continue }
			Object.defineProperty(result, key, {value: snapshot, enumerable: true, configurable: true, writable: true})
			totalBytes += entryBytes
			count++
		}
		return {attributes: result as LogAttributes, droppedCount}
	} catch {
		return {attributes: undefined, droppedCount: 1}
	}
}

function snapshotSpanValueWithState(
	value: unknown,
	maxStringLength: number,
	state: {ancestors: Set<object>; nodes: number; stringUnits: number}
): unknown {
	try { return snapshotJsonValue(value, 0, state, maxStringLength) } catch { return undefined }
}

function snapshotJsonValue(
	value: unknown,
	depth: number,
	state: {ancestors: Set<object>; nodes: number; stringUnits: number},
	maxStringLength: number
): unknown {
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'string') {
		if (value.length > maxStringLength - state.stringUnits) return undefined
		state.stringUnits += value.length
		return value
	}
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (!value || typeof value !== 'object') return undefined
	if (depth >= 8) return '[Truncated]'
	if (++state.nodes > 10_000) throw new TypeError('Tracing attribute graph exceeds the node budget')
	if (state.ancestors.has(value)) return undefined
	if (Array.isArray(value)) {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
		const lengthValue = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
		if (typeof lengthValue !== 'number' || !Number.isSafeInteger(lengthValue) || lengthValue < 0) return undefined
		const length = Math.min(lengthValue, 100)
		state.ancestors.add(value)
		try {
			const result: unknown[] = []
			for (let index = 0; index < length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
				if (!descriptor) { result.push(null); continue }
				if (!('value' in descriptor)) return undefined
				result.push(snapshotJsonValue(descriptor.value, depth + 1, state, maxStringLength) ?? null)
			}
			if (lengthValue > 100) result.push('[Truncated]')
			return result
		} finally { state.ancestors.delete(value) }
	}
	if (!isPlainObject(value)) return undefined
	state.ancestors.add(value)
	try {
		const result: Record<string, unknown> = {}
		let count = 0
		let scanned = 0
		for (const key in value) {
			if (++scanned > 400) break
			if (!isSafeSpanText(key, 256)) continue
			if (key.length > maxStringLength - state.stringUnits) continue
			if (!Object.hasOwn(value, key)) continue
			state.stringUnits += key.length
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable) continue
			if (!('value' in descriptor)) return undefined
			if (count >= 100) break
			if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
			const nested = snapshotJsonValue(descriptor.value, depth + 1, state, maxStringLength)
			if (nested === undefined) continue
			Object.defineProperty(result, key, {value: nested, enumerable: true, configurable: true, writable: true})
			count++
		}
		return result
	} finally { state.ancestors.delete(value) }
}
export function describeSpanException(error: unknown): {type: string; message: string; stack?: string} {
	try {
		if (error && typeof error === 'object') {
			const messageDescriptor = Object.getOwnPropertyDescriptor(error, 'message')
			const stackDescriptor = Object.getOwnPropertyDescriptor(error, 'stack')
			const message = messageDescriptor && 'value' in messageDescriptor && typeof messageDescriptor.value === 'string'
				? messageDescriptor.value : '[unavailable]'
			const stack = stackDescriptor && 'value' in stackDescriptor && typeof stackDescriptor.value === 'string'
				? stackDescriptor.value : undefined
			return {
				type: safeErrorType(error as Error),
				message,
				...(stack ? {stack} : {})
			}
		}
	} catch { /* fall through to a safe opaque projection */ }
	const message = error === null ? 'null' :
		typeof error === 'string' ? error :
			typeof error === 'bigint' ? '[bigint]' :
				(typeof error === 'number' || typeof error === 'boolean') ? `${error}` : '[unavailable]'
	return {type: typeof error, message}
}

function safeErrorType(error: Error): string {
	try {
		let prototype: object | null = Object.getPrototypeOf(error) as object | null
		for (let depth = 0; prototype && depth < 32; depth++) {
			const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
			if (constructor && 'value' in constructor && typeof constructor.value === 'function') {
				const name = Object.getOwnPropertyDescriptor(constructor.value, 'name')
				if (name && 'value' in name && typeof name.value === 'string' && name.value) return name.value
			}
			prototype = Object.getPrototypeOf(prototype) as object | null
		}
	} catch { /* use the stable base type */ }
	return 'Error'
}

export function deepFreezeSpanRecord<T>(value: T): T {
	if (!value || typeof value !== 'object' || nativeObjectIsFrozen(value)) return value
	const nestedValues = nativeObjectValues(value as Record<string, unknown>)
	for (let index = 0; index < nestedValues.length; index++) deepFreezeSpanRecord(nestedValues[index])
	return nativeObjectFreeze(value)
}

const nativeObjectFreeze = Object.freeze
const nativeObjectIsFrozen = Object.isFrozen
const nativeObjectValues = Object.values
