import {isRuntimeProxy} from './runtime-object'

export interface JsonSnapshotLimits {
	readonly code: string
	readonly maxArrayLength: number
	readonly maxBytes: number
	readonly maxDepth: number
	readonly maxEntries: number
	readonly maxKeyLength: number
	readonly maxNodes: number
	readonly maxStringLength: number
	readonly allowUndefined?: boolean
}

const textEncoder = new TextEncoder()
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype'])
let activeDefinitionReflections = 0
let definitionReflectionCalls = 0

const runBoundedRuntimeReflection = <T>(callback: () => T): T => {
	if (!activeDefinitionReflections) definitionReflectionCalls = 0
	if (definitionReflectionCalls++ >= 100) throw new TypeError()
	activeDefinitionReflections += 1
	try { return callback() } finally { activeDefinitionReflections -= 1 }
}

export const failDefinition = (code: string): never => {
	throw new TypeError(code)
}

export function readPlainRecord(
	value: unknown,
	code: string,
	allowedKeys?: ReadonlySet<string>,
	maximum = 256
): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== 'object' || Array.isArray(value) || isRuntimeProxy(value)) failDefinition(code)
	const record = value as object
	try {
		return runBoundedRuntimeReflection(() => {
			const prototype = Object.getPrototypeOf(record) as object | null
			if (prototype !== Object.prototype && prototype !== null) failDefinition(code)
			const keys = Reflect.ownKeys(record)
			if (keys.length > (allowedKeys?.size ?? maximum)) failDefinition(code)
			const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
			for (const key of keys) {
				const stringKey = typeof key === 'string' ? key : failDefinition(code)
				if (allowedKeys && !allowedKeys.has(stringKey)) failDefinition(code)
				const descriptor = Object.getOwnPropertyDescriptor(record, stringKey)
				const entry = descriptor?.enumerable && 'value' in descriptor ? descriptor.value : failDefinition(code)
				snapshot[stringKey] = entry
			}
			return Object.freeze(snapshot)
		})
	} catch {
		return failDefinition(code)
	}
}

export function readDenseArray(value: unknown, maximum: number, code: string): readonly unknown[] {
	if (!Array.isArray(value) || isRuntimeProxy(value)) failDefinition(code)
	const array = value as unknown[]
	try {
		return runBoundedRuntimeReflection(() => {
			const lengthDescriptor = Object.getOwnPropertyDescriptor(array, 'length')
			const length = lengthDescriptor && 'value' in lengthDescriptor
				? lengthDescriptor.value as number
				: failDefinition(code)
			if (!Number.isSafeInteger(length) || length > maximum) failDefinition(code)
			const keys = Reflect.ownKeys(array)
			if (keys.length > maximum + 1 || keys.some((key) => (
				typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key))
			))) failDefinition(code)

			const result: unknown[] = []
			for (let index = 0; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(array, String(index))
				result.push(descriptor?.enumerable && 'value' in descriptor ? descriptor.value : failDefinition(code))
			}
			return Object.freeze(result)
		})
	} catch {
		return failDefinition(code)
	}
}

export function boundedString(
	value: unknown,
	code: string,
	maximum: number,
	pattern?: RegExp
): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum || (pattern && !pattern.test(value))) {
		failDefinition(code)
	}
	return value as string
}

export function optionalBoundedString(value: unknown, code: string, maximum: number): string | undefined {
	return value === undefined ? undefined : boundedString(value, code, maximum)
}

export function snapshotJsonValue(value: unknown, limits: JsonSnapshotLimits): unknown {
	const seen = new WeakSet<object>()
	let nodes = 0
	let bytes = 0

	const consume = (amount: number): void => {
		bytes += amount
		if (bytes > limits.maxBytes) failDefinition(limits.code)
	}
	const visit = (candidate: unknown, depth: number): unknown => {
		nodes += 1
		if (nodes > limits.maxNodes || depth > limits.maxDepth) failDefinition(limits.code)
		if (candidate === null || typeof candidate === 'boolean') return candidate
		if (typeof candidate === 'string') {
			if (candidate.length > limits.maxStringLength) failDefinition(limits.code)
			consume(textEncoder.encode(candidate).byteLength)
			return candidate
		}
		if (typeof candidate === 'number') {
			if (!Number.isFinite(candidate)) failDefinition(limits.code)
			return candidate
		}
		if (candidate === undefined && limits.allowUndefined && depth === 1) return undefined
		if (typeof candidate !== 'object' || candidate === null || isRuntimeProxy(candidate)) failDefinition(limits.code)
		const objectCandidate = candidate as object
		if (seen.has(objectCandidate)) failDefinition(limits.code)
		seen.add(objectCandidate)

		if (Array.isArray(candidate)) {
			const input = readDenseArray(candidate, limits.maxArrayLength, limits.code)
			const output = input.map((entry) => visit(entry, depth + 1))
			return Object.freeze(output)
		}

		const input = readPlainRecord(candidate, limits.code, undefined, limits.maxEntries)
		const entries = Object.entries(input)
		if (entries.length > limits.maxEntries) failDefinition(limits.code)
		const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const [key, entry] of entries) {
			if (key.length === 0 || key.length > limits.maxKeyLength || dangerousKeys.has(key)) failDefinition(limits.code)
			consume(textEncoder.encode(key).byteLength)
			output[key] = visit(entry, depth + 1)
		}
		return Object.freeze(output)
	}

	const snapshot = visit(value, 0)
	const serialized = JSON.stringify(snapshot)
	if (serialized !== undefined && textEncoder.encode(serialized).byteLength > limits.maxBytes) failDefinition(limits.code)
	return snapshot
}
