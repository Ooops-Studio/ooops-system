import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {MonotonicMillisClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'

import {
	MAX_LIFECYCLE_IDENTIFIER_LENGTH,
	MAX_LIFECYCLE_TIMER_MS
} from '../constants'

export function snapshotRecord(
	value: unknown,
	label: string,
	allowed: ReadonlySet<string>
): Record<string, unknown> {
	if (!value || typeof value !== 'object') throw new Error(`${label} must be an object`)
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	try {
		if (Array.isArray(value)) throw new Error(`${label} must be an object`)
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value)
	} catch(error) {
		if (stableErrorMessage(error) === `${label} must be an object`) throw error
		throw new Error(`${label} must expose stable data fields`)
	}
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${label} must be a plain data object`)
	}
	const snapshot: Record<string, unknown> = {}
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !allowed.has(key)) {
			throw new Error(`${label} contains unsupported fields`)
		}
		const descriptor = descriptors[key]
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new Error(`${label} must expose stable data fields`)
		}
		snapshot[key] = descriptor.value
	}
	return snapshot
}

export function captureClock(value: unknown, label: string): Clock | MonotonicMillisClock {
	if (!value || typeof value !== 'object') throw new Error(`${label} is required`)
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = Object.getOwnPropertyDescriptor(value, 'now') } catch {
		throw new Error(`${label} must expose a stable now()`)
	}
	if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
		throw new Error(`${label} must expose a stable now()`)
	}
	const nowMethod = descriptor.value as () => number
	const now = (): number => Reflect.apply(nowMethod, value, [])
	const first = now()
	if (!Number.isFinite(first)) throw new Error(`${label} now() must return a finite number`)
	let last = first
	return Object.freeze({now: () => {
		try {
			const current = now()
			if (Number.isFinite(current)) last = current
		} catch { /* retain the last finite reading */ }
		return last
	}})
}

export function boundedTimer(value: unknown, fallback: number, label: string): number {
	const resolved = value ?? fallback
	if (!Number.isFinite(resolved) || typeof resolved !== 'number' || resolved < 0 || resolved > MAX_LIFECYCLE_TIMER_MS) {
		throw new Error(`${label} must be between 0 and ${MAX_LIFECYCLE_TIMER_MS}`)
	}
	return resolved
}

export function boundedInteger(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string
): number {
	const resolved = value ?? fallback
	if (!Number.isInteger(resolved) || typeof resolved !== 'number' || resolved < minimum || resolved > maximum) {
		throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
	}
	return resolved
}

export function lifecycleIdentifier(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > MAX_LIFECYCLE_IDENTIFIER_LENGTH) {
		throw new Error(`${label} must be a non-empty string of at most ${MAX_LIFECYCLE_IDENTIFIER_LENGTH} characters`)
	}
	return value
}

export function stableErrorMessage(value: unknown): string | undefined {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'message')
		return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
			? descriptor.value
			: undefined
	} catch { return undefined }
}

function safeAttributes(value: unknown): LogAttributes | undefined {
	if (!value || typeof value !== 'object') return undefined
	let descriptors: PropertyDescriptorMap
	let prototype: object | null
	try {
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value)
	} catch { return undefined }
	if (prototype !== Object.prototype && prototype !== null) return undefined
	const result: Record<string, string | number | boolean> = {}
	let count = 0
	for (const key of Object.keys(descriptors)) {
		if (count >= 32) break
		const descriptor = descriptors[key]
		if (!descriptor?.enumerable || !('value' in descriptor)) continue
		const item = descriptor.value
		if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') continue
		result[key.slice(0, 128)] = typeof item === 'string' ? item.slice(0, 512) : item
		count++
	}
	return Object.freeze(result)
}

export function snapshotResource(value: unknown): ObservabilityResource | undefined {
	if (value === undefined) return undefined
	const snapshot = snapshotRecord(value, 'Lifecycle resource', new Set([
		'serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime', 'attributes'
	]))
	const serviceName = lifecycleIdentifier(snapshot.serviceName, 'Lifecycle resource serviceName')
	const stringField = (key: string): string | undefined => {
		const item = snapshot[key]
		if (item === undefined) return undefined
		return lifecycleIdentifier(item, `Lifecycle resource ${key}`)
	}
	const serviceVersion = stringField('serviceVersion')
	const deploymentEnvironment = stringField('deploymentEnvironment')
	const hostKind = stringField('hostKind')
	const runtime = stringField('runtime')
	const attributes = safeAttributes(snapshot.attributes)
	return Object.freeze({
		serviceName,
		...(serviceVersion ? {serviceVersion} : {}),
		...(deploymentEnvironment ? {deploymentEnvironment} : {}),
		...(hostKind ? {hostKind} : {}),
		...(runtime ? {runtime} : {}),
		...(attributes ? {attributes} : {})
	})
}
