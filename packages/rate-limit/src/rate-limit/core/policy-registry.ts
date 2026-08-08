import type {RateLimitPolicyDefinition} from '@ooopsstudio/core/contracts/rate-limit'

import {MAX_SAFE_MICROTOKEN_AMOUNT} from '../constants'
import {isRateLimitProxy} from '../utils/safe-object'

export interface RuntimeRateLimitPolicy {
	readonly name: string
	readonly partition: 'global' | 'keyed'
	readonly algorithm: 'fixed-window' | 'token-bucket'
	readonly limit: number
	readonly windowMs: number
	readonly defaultCost: number
	readonly maxCost: number
	readonly capacity: number
	readonly mode: 'enforce' | 'shadow'
	readonly fingerprint: string
}

const MAX_POLICIES = 256
const POLICY_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u
const POLICY_FIELDS = new Set([
	'name', 'partition', 'algorithm', 'limit', 'windowMs', 'defaultCost', 'maxCost', 'capacity', 'mode'
])

function dataSnapshot(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || isRateLimitProxy(value) || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`)
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !POLICY_FIELDS.has(key))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		const snapshot = Object.create(null) as Record<string, unknown>
		for (const [key, descriptor] of Object.entries(descriptors)) snapshot[key] = descriptor.value
		return snapshot
	} catch {
		throw new TypeError(`${label} contains invalid, accessor-backed, or unexpected fields`)
	}
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive safe integer`)
	return value as number
}

function snapshotPolicy(value: unknown): RuntimeRateLimitPolicy {
	const raw = dataSnapshot(value, 'Rate limit policy')
	if (typeof raw.name !== 'string' || !POLICY_NAME.test(raw.name)) {
		throw new TypeError('Rate limit policy name is invalid')
	}
	if (raw.partition !== 'global' && raw.partition !== 'keyed') {
		throw new TypeError(`Rate limit policy "${raw.name}" partition must be "global" or "keyed"`)
	}
	const algorithm = raw.algorithm ?? 'fixed-window'
	if (algorithm !== 'fixed-window' && algorithm !== 'token-bucket') {
		throw new TypeError(`Rate limit policy "${raw.name}" algorithm is invalid`)
	}
	const limit = positiveInteger(raw.limit, `Rate limit policy "${raw.name}" limit`)
	const windowMs = positiveInteger(raw.windowMs, `Rate limit policy "${raw.name}" windowMs`)
	const defaultCost = raw.defaultCost === undefined ? 1 : positiveInteger(raw.defaultCost, `Rate limit policy "${raw.name}" defaultCost`)
	const capacity = raw.capacity === undefined ? limit : positiveInteger(raw.capacity, `Rate limit policy "${raw.name}" capacity`)
	if (algorithm === 'fixed-window' && raw.capacity !== undefined) {
		throw new TypeError(`Rate limit policy "${raw.name}" capacity is only valid for token-bucket policies`)
	}
	if (algorithm === 'token-bucket') {
		if (limit > MAX_SAFE_MICROTOKEN_AMOUNT || capacity > MAX_SAFE_MICROTOKEN_AMOUNT ||
			capacity / (limit / windowMs) > Number.MAX_SAFE_INTEGER) {
			throw new TypeError(`Rate limit token-bucket policy "${raw.name}" exceeds safe numeric precision`)
		}
	}
	const maximumAvailable = algorithm === 'token-bucket' ? capacity : limit
	const maxCost = raw.maxCost === undefined ? maximumAvailable : positiveInteger(raw.maxCost, `Rate limit policy "${raw.name}" maxCost`)
	if (maxCost > maximumAvailable || defaultCost > maxCost) {
		throw new TypeError(`Rate limit policy "${raw.name}" costs exceed its available capacity`)
	}
	const mode = raw.mode ?? 'enforce'
	if (mode !== 'enforce' && mode !== 'shadow') throw new TypeError(`Rate limit policy "${raw.name}" mode is invalid`)
	const fingerprint = JSON.stringify([raw.name, raw.partition, algorithm, limit, windowMs, capacity])
	return Object.freeze({
		name: raw.name,
		partition: raw.partition,
		algorithm,
		limit,
		windowMs,
		defaultCost,
		maxCost,
		capacity,
		mode,
		fingerprint
	})
}

export function createRateLimitPolicyRegistry(
	definitions: readonly RateLimitPolicyDefinition[]
): ReadonlyMap<string, RuntimeRateLimitPolicy> {
	if (isRateLimitProxy(definitions) || !Array.isArray(definitions) || definitions.length === 0 || definitions.length > MAX_POLICIES) {
		throw new TypeError(`Rate limit policies must contain between 1 and ${MAX_POLICIES} definitions`)
	}
	const registry = new Map<string, RuntimeRateLimitPolicy>()
	for (let index = 0; index < definitions.length; index++) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(definitions, String(index)) } catch { /* rejected below */ }
		if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
			throw new TypeError('Rate limit policies must be a dense data-only array')
		}
		const policy = snapshotPolicy(descriptor.value)
		if (registry.has(policy.name)) throw new TypeError(`Duplicate rate limit policy: ${policy.name}`)
		registry.set(policy.name, policy)
	}
	return registry
}
