/**
 * @file Event helper utilities for performance service.
 * Shared constants and functions for event processing.
 */

import {isRuntimeProxy} from '../../utils/safe-object'

/**
 * DB event name prefix
 */
export const DB_EVENT_PREFIX = 'db.'

const RESOURCE_SNAPSHOT_EVENT_NAMES = new Set(['cpu_usage', 'memory_usage'])

/**
 * Check if an event name is a DB event
 */
export function isDBEvent(name: string): boolean {
	return name.startsWith(DB_EVENT_PREFIX)
}

/** Runtime resource snapshots carry changing numeric values, not dimensions. */
export function isResourceSnapshotEvent(source: string, name: string): boolean {
	return source === 'runtime' && RESOURCE_SNAPSHOT_EVENT_NAMES.has(name)
}

/** Deeply snapshots plain performance payloads even when structuredClone rejects custom values. */
export function clonePerformanceValue<T>(value: T): T {
	const seen = new WeakMap<object, unknown>()
	let remainingNodes = 512
	let remainingCharacters = 16_384
	const clone = (current: unknown, depth = 0): unknown => {
		if (typeof current === 'string') {
			const length = Math.min(current.length, remainingCharacters, 1_024)
			remainingCharacters -= length
			return current.slice(0, length)
		}
		if (typeof current === 'bigint') return current.toString()
		if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return current
		if (typeof current === 'function' || isRuntimeProxy(current) || depth > 8 || remainingNodes-- <= 0) return undefined
		const existing = seen.get(current)
		if (existing !== undefined) return existing
		try {
			const timestamp = Reflect.apply(Date.prototype.getTime, current, []) as number
			const snapshot = new Date(timestamp)
			seen.set(current, snapshot)
			return snapshot
		} catch { /* native brand check identifies non-Date values without walking prototypes */ }
		try {
			if (Array.isArray(current)) {
				const result: unknown[] = []
				seen.set(current, result)
				const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length')
				const length = Math.min(lengthDescriptor && 'value' in lengthDescriptor
					? lengthDescriptor.value as number : 0, 32)
				for (let index = 0; index < length; index += 1) {
					const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
					result.push(descriptor && 'value' in descriptor ? clone(descriptor.value, depth + 1) : undefined)
				}
				return result
			}
		} catch {
			return undefined
		}
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		seen.set(current, result)
		let copied = 0
		try {
			for (const key in current) {
				if (copied >= 64) break
				if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
				const descriptor = Object.getOwnPropertyDescriptor(current, key)
				if (!descriptor?.enumerable || !('value' in descriptor)) continue
				const cloned = clone(descriptor.value, depth + 1)
				if (cloned !== undefined || descriptor.value === undefined) result[key] = cloned
				copied += 1
			}
		} catch { return result }
		return result
	}
	return clone(value) as T
}

const SAFE_DB_FIELDS = new Set([
	'operation', 'table', 'collection', 'rows', 'method', 'limit', 'offset',
	'orderBy', 'permissionExpansion', 'projection', 'documentCount', 'payloadSize',
	'statusCode', 'retryCount', 'timeout', 'success', 'failureCode', 'queryHash'
])

/** Captures only the non-sensitive DB metadata contract. */
export function snapshotSafeDBMetadata(value: unknown): import('@ooopsstudio/core/contracts/performance').DBQueryMetadata | undefined {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value) || Array.isArray(value)) return undefined
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	for (const key of SAFE_DB_FIELDS) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { return undefined }
		if (!descriptor?.enumerable || !('value' in descriptor)) continue
		const field = descriptor.value
		if (key === 'failureCode') {
			if (field === 'query_failed') result[key] = field
		} else if (typeof field === 'string') result[key] = field.slice(0, 256)
		else if (typeof field === 'number' && Number.isFinite(field)) result[key] = field
		else if (typeof field === 'boolean') result[key] = field
		else {
			const values = clonePerformanceValue(field)
			if (Array.isArray(values)) result[key] = values
				.filter((item): item is string => typeof item === 'string')
				.map((item) => item.slice(0, 128))
		}
	}
	return result as import('@ooopsstudio/core/contracts/performance').DBQueryMetadata
}

export function deepFreezePerformanceValue<T>(value: T, seen = new WeakSet<object>()): T {
	if (!value || typeof value !== 'object' || seen.has(value)) return value
	seen.add(value)
	for (const child of Object.values(value as Record<string, unknown>)) deepFreezePerformanceValue(child, seen)
	return Object.freeze(value)
}
