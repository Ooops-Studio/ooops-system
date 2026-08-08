import type {PerformanceEventRecord} from '@ooopsstudio/core/contracts/performance'

import {isRuntimeProxy} from '../utils/safe-object'

import {createPerformanceExportError} from './export-errors'

export const MAX_PERFORMANCE_TIMER_MS = 2_147_483_647
export const MAX_PERFORMANCE_EXPORT_BATCH_COUNT = 256
export const MAX_PERFORMANCE_EXPORT_BATCH_BYTES = 1_048_576

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withPerformanceExportTimeout<T>(
	operation: Promise<T> | T,
	timeoutMs: number,
	label: string
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			Promise.resolve(operation),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(createPerformanceExportError(
					`${label} timed out after ${timeoutMs}ms`,
					{retryable: true, code: 'performance_export_timeout'}
				)), timeoutMs)
			})
		])
	} finally {
		try { if (timer !== undefined) clearTimeout(timer) } catch { /* delivery result remains authoritative */ }
	}
}

export function serializePerformanceEventRecord(
	record: PerformanceEventRecord
): {serialized: string; bytes: number} | null {
	try {
		let remainingNodes = 1_024
		let remainingStringBytes = MAX_PERFORMANCE_EXPORT_BATCH_BYTES
		const ancestors = new WeakSet<object>()
		const snapshot = (value: unknown, depth = 0): unknown => {
			if (typeof value === 'string') {
				if (value.length > remainingStringBytes) throw new TypeError()
				const bytes = Buffer.byteLength(value, 'utf8')
				if (bytes > remainingStringBytes) throw new TypeError()
				remainingStringBytes -= bytes
				return value
			}
			if (value === null || typeof value === 'boolean') return value
			if (typeof value === 'number') {
				if (!Number.isFinite(value)) throw new TypeError()
				return value
			}
			if (value === undefined) return undefined
			if (typeof value !== 'object' || isRuntimeProxy(value) || depth > 12 || remainingNodes-- <= 0 || ancestors.has(value)) {
				throw new TypeError()
			}
			ancestors.add(value)
			try {
				const prototype = Object.getPrototypeOf(value)
				if (Array.isArray(value)) {
					const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
					const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
					if (!Number.isSafeInteger(length) || length < 0 || length > 256) throw new TypeError()
					const result: unknown[] = []
					if (!Reflect.setPrototypeOf(result, null)) throw new TypeError()
					for (let index = 0; index < length; index += 1) {
						const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
						if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError()
						result[index] = snapshot(descriptor.value, depth + 1)
					}
					return result
				}
				if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
				const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
				let entries = 0
				for (const key in value) {
					if (entries >= 128) throw new TypeError()
					if (key.length > remainingStringBytes) throw new TypeError()
					const keyBytes = Buffer.byteLength(key, 'utf8')
					if (keyBytes > remainingStringBytes) throw new TypeError()
					remainingStringBytes -= keyBytes
					const descriptor = Object.getOwnPropertyDescriptor(value, key)
					if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError()
					entries += 1
					const captured = snapshot(descriptor.value, depth + 1)
					if (captured !== undefined) result[key] = captured
				}
				return result
			} finally { ancestors.delete(value) }
		}
		const captured = snapshot(record) as PerformanceEventRecord
		if (!captured || typeof captured !== 'object' || typeof captured.recordedAt !== 'number' ||
			typeof captured.source !== 'string' || !captured.event || typeof captured.event !== 'object') return null
		const serialized = JSON.stringify(captured)
		return {serialized, bytes: Buffer.byteLength(serialized, 'utf8')}
	} catch {
		return null
	}
}
