import type {JobPayload, JobResult} from '@ooopsstudio/core/contracts/jobs'

const MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_PAYLOAD_DEPTH = 32
const MAX_PAYLOAD_NODES = 10_000

/** Redis Lua cjson preserves at most 14 significant digits exactly. */
export const hasJobsNumberPrecision = (value: number): boolean =>
	Number(value.toPrecision(14)) === value

export const hasInvalidJsonText = (value: string): boolean => {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code === 0) return true
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true
			index += 1
		} else if (code >= 0xdc00 && code <= 0xdfff) return true
	}
	return false
}

export function validateJobPayload(payload: unknown): asserts payload is JobPayload {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Job payload must be an object')
	const ancestors = new Set<object>()
	let nodes = 0
	const visit = (value: unknown, depth: number): void => {
		if (++nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) throw new Error('Job payload exceeds structural limits')
		if (value === undefined) {
			if (depth === 1) return
			throw new Error('Job payload must not contain nested undefined values')
		}
		if (value === null || typeof value === 'boolean') return
		if (typeof value === 'string') {
			if (hasInvalidJsonText(value)) throw new Error('Job payload strings must contain PostgreSQL-compatible Unicode')
			return
		}
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) throw new Error('Job payload must contain finite JSON values')
			if (!hasJobsNumberPrecision(value)) throw new Error('Job payload numbers must use at most 14 significant digits')
			return
		}
		if (typeof value !== 'object') throw new Error('Job payload must contain JSON values')
		if (ancestors.has(value)) throw new Error('Job payload must not contain cycles')
		const array = Array.isArray(value)
		let prototype: object | null
		let descriptors: PropertyDescriptorMap
		let symbols: symbol[]
		try {
			prototype = Object.getPrototypeOf(value)
			if (array) {
				const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
				if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PAYLOAD_NODES) {
					throw new Error('Job payload exceeds structural limits')
				}
			}
			descriptors = Object.getOwnPropertyDescriptors(value)
			symbols = Object.getOwnPropertySymbols(value)
		} catch(error) {
			if (error instanceof Error && error.message === 'Job payload exceeds structural limits') throw error
			throw new Error('Job payload must expose stable data properties')
		}
		if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('Job payload must contain plain JSON objects')
		if (array) {
			const length = descriptors.length!.value as number
			for (let index = 0; index < length; index++) {
				const descriptor = descriptors[String(index)]
				if (!descriptor || !('value' in descriptor)) throw new Error('Job payload arrays must be dense data arrays')
			}
			for (const [key, descriptor] of Object.entries(descriptors)) {
				if (key !== 'length' && descriptor.enumerable
					&& (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length)) {
					throw new Error('Job payload arrays must not contain extra properties')
				}
			}
		}
		if (Object.hasOwn(descriptors, 'toJSON')) throw new Error('Job payload must not define toJSON')
		if (symbols.some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))) {
			throw new Error('Job payload must not contain enumerable symbol keys')
		}
		ancestors.add(value)
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (array ? key === 'length' || !/^(?:0|[1-9]\d*)$/u.test(key) : !descriptor.enumerable) continue
			if (hasInvalidJsonText(key)) throw new Error('Job payload keys must contain PostgreSQL-compatible Unicode')
			if (!('value' in descriptor)) throw new Error('Job payload must not contain accessors')
			visit(descriptor.value, depth + 1)
		}
		ancestors.delete(value)
	}
	visit(payload, 0)
	if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw new Error('Job payload exceeds 1048576 bytes')
}

function snapshotJsonData(value: unknown, label: string): unknown {
	const ancestors = new Set<object>()
	let nodes = 0
	const visit = (candidate: unknown, depth: number): unknown => {
		if (++nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) throw new Error(`${label} exceeds structural limits`)
		if (candidate === null || typeof candidate !== 'object') return candidate
		if (ancestors.has(candidate)) throw new Error(`${label} must not contain cycles`)
		const array = Array.isArray(candidate)
		let prototype: object | null
		let descriptors: PropertyDescriptorMap
		try {
			prototype = Object.getPrototypeOf(candidate)
			if (array) {
				const length = Object.getOwnPropertyDescriptor(candidate, 'length')?.value
				if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PAYLOAD_NODES) {
					throw new Error(`${label} exceeds structural limits`)
				}
			}
			descriptors = Object.getOwnPropertyDescriptors(candidate)
		} catch(error) {
			if (error instanceof Error && error.message === `${label} exceeds structural limits`) throw error
			throw new Error(`${label} must expose stable data properties`)
		}
		const symbols = Reflect.ownKeys(descriptors).filter((key): key is symbol => typeof key === 'symbol')
		if ((array && prototype !== Array.prototype)
			|| (!array && prototype !== Object.prototype && prototype !== null)
			|| symbols.some((symbol) => Object.prototype.propertyIsEnumerable.call(candidate, symbol))) {
			throw new Error(`${label} must contain plain JSON data`)
		}
		ancestors.add(candidate)
		try {
			if (array) {
				const length = descriptors.length?.value
				if (!Number.isSafeInteger(length) || length > MAX_PAYLOAD_NODES) throw new Error(`${label} exceeds structural limits`)
				const result: unknown[] = new Array(length)
				for (let index = 0; index < length; index++) {
					const descriptor = descriptors[String(index)]
					if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error(`${label} arrays must be dense data arrays`)
					result[index] = visit(descriptor.value, depth + 1)
				}
				for (const [key, descriptor] of Object.entries(descriptors)) {
					if (key === 'length' || (/^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < length)) continue
					if (descriptor.enumerable || !('value' in descriptor)) throw new Error(`${label} arrays must not contain extra properties`)
				}
				return result
			}
			if (Object.hasOwn(descriptors, 'toJSON')) throw new Error(`${label} must not define toJSON`)
			const result: Record<string, unknown> = {}
			for (const [key, descriptor] of Object.entries(descriptors)) {
				if (!descriptor.enumerable) continue
				if (!('value' in descriptor)) throw new Error(`${label} must not contain accessors`)
				// JobPayload intentionally permits undefined at its top level, matching
				// ordinary JSON object semantics. Canonicalize it before checksumming or
				// persistence so every backend observes the same durable value.
				if (depth === 0 && descriptor.value === undefined) continue
				Object.defineProperty(result, key, {
					value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true
				})
			}
			return result
		} finally { ancestors.delete(candidate) }
	}
	return visit(value, 0)
}

export function snapshotJobPayload(payload: unknown): JobPayload {
	const snapshot = snapshotJsonData(payload, 'Job payload')
	validateJobPayload(snapshot)
	return snapshot
}

export function snapshotJobResult(result: unknown): JobResult | undefined {
	if (result === undefined) return undefined
	if (result && typeof result === 'object' && !Array.isArray(result)) return snapshotJobPayload(result)
	return snapshotJobPayload({result}).result
}

export function validateJobResult(result: unknown): void {
	if (result === undefined) return
	if (result && typeof result === 'object' && !Array.isArray(result)) validateJobPayload(result)
	else validateJobPayload({result})
}
