import {MAX_CACHE_ENTRY_BYTES} from './runtime-safety'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {fatal: true})
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 100_000
const encodedNull = encoder.encode('null')

export function isEncodedNegativeCacheValue(value: Uint8Array): boolean {
	return value.byteLength === encodedNull.byteLength
		&& value.every((byte, index) => byte === encodedNull[index])
}

function snapshotJsonInput(value: unknown): unknown {
	const ancestors = new WeakSet<object>()
	let nodes = 0
	let serializedBytes = 0
	const addSerializedBytes = (bytes: number): void => {
		serializedBytes += bytes
		if (!Number.isSafeInteger(serializedBytes) || serializedBytes > MAX_CACHE_ENTRY_BYTES) {
			throw new RangeError(`Cache entry exceeds the ${MAX_CACHE_ENTRY_BYTES}-byte limit`)
		}
	}
	const countJsonString = (current: string): void => {
		// Every UTF-16 code unit consumes at least one JSON byte. Reject obviously
		// oversized strings before scanning their full contents, then stop as soon
		// as escaping/UTF-8 expansion crosses the remaining budget.
		if (current.length + 2 > MAX_CACHE_ENTRY_BYTES - serializedBytes) {
			throw new RangeError(`Cache entry exceeds the ${MAX_CACHE_ENTRY_BYTES}-byte limit`)
		}
		let bytes = 2
		for (let index = 0; index < current.length; index++) {
			const code = current.charCodeAt(index)
			if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
				|| code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2
			else if (code < 0x20) bytes += 6
			else if (code < 0x80) bytes++
			else if (code < 0x800) bytes += 2
			else if (code >= 0xd800 && code <= 0xdbff
				&& current.charCodeAt(index + 1) >= 0xdc00 && current.charCodeAt(index + 1) <= 0xdfff) {
				bytes += 4
				index++
			} else if (code >= 0xd800 && code <= 0xdfff) bytes += 6
			else bytes += 3
			if (bytes > MAX_CACHE_ENTRY_BYTES - serializedBytes) {
				throw new RangeError(`Cache entry exceeds the ${MAX_CACHE_ENTRY_BYTES}-byte limit`)
			}
		}
		addSerializedBytes(bytes)
	}
	const visit = (current: unknown, depth: number): unknown => {
		if (++nodes > MAX_JSON_NODES) throw new RangeError('Cache JSON value exceeds the structural node limit')
		if (depth > MAX_JSON_DEPTH) throw new RangeError('Cache JSON value exceeds the depth limit')
		if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
			throw new TypeError('Cache values must not contain undefined, functions, or symbols')
		}
		if (typeof current === 'number' && !Number.isFinite(current)) {
			throw new TypeError('Cache values must contain only finite numbers')
		}
		if (typeof current === 'bigint') throw new TypeError('Cache values must not contain bigint')
		if (typeof current === 'string') countJsonString(current)
		else if (typeof current === 'number') addSerializedBytes(Object.is(current, -0) ? 1 : String(current).length)
		else if (typeof current === 'boolean') addSerializedBytes(current ? 4 : 5)
		else if (current === null) addSerializedBytes(4)
		if (!current || typeof current !== 'object') return current
		if (ancestors.has(current)) throw new TypeError('Cache values must not contain circular references')
		if (current instanceof Date) throw new TypeError('Cache values must not contain Date objects')
		const prototype = Object.getPrototypeOf(current)
		if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
			throw new TypeError('Cache values must contain only JSON objects and arrays')
		}
		ancestors.add(current)
		try {
			// Take one descriptor snapshot. Re-reading ownKeys/length/value from a
			// Proxy would create a validation/serialization time-of-check gap.
			const descriptors = Object.getOwnPropertyDescriptors(current)
			const ownKeys = Reflect.ownKeys(descriptors)
			if (!Array.isArray(current) && ownKeys.length > MAX_JSON_NODES - nodes) {
				throw new RangeError('Cache JSON value exceeds the structural node limit')
			}
			if (ownKeys.some((key) => typeof key === 'symbol')) {
				throw new TypeError('Cache values must not contain symbol keys')
			}
			if (Array.isArray(current)) {
				const arrayLength = descriptors.length?.value
				if (!Number.isSafeInteger(arrayLength) || arrayLength < 0 || arrayLength > MAX_JSON_NODES - nodes) {
					throw new RangeError('Cache JSON value exceeds the structural node limit')
				}
				const allowedArrayKeys = new Set([
					'length',
					...Array.from({length: arrayLength}, (_item, index) => String(index))
				])
				if (ownKeys.some((key) => !allowedArrayKeys.has(String(key)))) {
					throw new TypeError('Cache arrays must not contain custom properties')
				}
			} else if (ownKeys.some((key) => !descriptors[String(key)]?.enumerable)) {
				throw new TypeError('Cache objects must not contain non-enumerable properties')
			}
			const itemCount = Array.isArray(current) ? Number(descriptors.length?.value) : ownKeys.length
			addSerializedBytes(2 + Math.max(0, itemCount - 1) + (Array.isArray(current) ? 0 : itemCount))
			if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
				throw new TypeError('Cache values must not contain accessor properties')
			}
			if (Array.isArray(current)) {
				const output: unknown[] = []
				for (let index = 0; index < itemCount; index++) {
					const descriptor = descriptors[String(index)]
					if (!descriptor?.enumerable || !('value' in descriptor)) {
						throw new TypeError('Cache values must not contain sparse arrays')
					}
					output.push(visit(descriptor.value, depth + 1))
				}
				return output
			}
			const output = Object.create(null) as Record<string, unknown>
			for (const key of ownKeys as string[]) {
				const descriptor = descriptors[key]
				if (!descriptor?.enumerable || !('value' in descriptor)) {
					throw new TypeError('Cache objects must contain data properties only')
				}
				countJsonString(key)
				output[key] = visit(descriptor.value, depth + 1)
			}
			return output
		} finally {
			ancestors.delete(current)
		}
	}
	return visit(value, 0)
}

export function encodeCacheValue(value: unknown): Uint8Array {
	const snapshot = snapshotJsonInput(value)
	const serialized = JSON.stringify(snapshot)
	if (serialized === undefined) throw new TypeError('Cache cannot encode undefined without negativeTtlMs')
	const encoded = encoder.encode(serialized)
	if (encoded.byteLength > MAX_CACHE_ENTRY_BYTES) {
		throw new RangeError(`Cache entry exceeds the ${MAX_CACHE_ENTRY_BYTES}-byte limit`)
	}
	return encoded
}

export function decodeCacheValue<T>(value: Uint8Array): T {
	if (value.byteLength > MAX_CACHE_ENTRY_BYTES) {
		throw new RangeError(`Cache entry exceeds the ${MAX_CACHE_ENTRY_BYTES}-byte limit`)
	}
	const decoded = JSON.parse(decoder.decode(value)) as unknown
	return snapshotJsonInput(decoded) as T
}
