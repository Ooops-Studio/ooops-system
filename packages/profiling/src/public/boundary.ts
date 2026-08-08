import type {StandardProfilingOptions} from './types'

export function readProfilingData<T = unknown>(value: object, key: PropertyKey, code: string): T | undefined {
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw Error(code) }
	if (!descriptor) return undefined
	if (!('value' in descriptor)) throw Error(code)
	return descriptor.value as T
}

export function snapshotStandardOptions(value: StandardProfilingOptions | undefined, code: string): StandardProfilingOptions {
	if (value === undefined) return Object.freeze({})
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(code)
	const clock = readProfilingData<StandardProfilingOptions['clock']>(value, 'clock', code)
	const resource = readProfilingData<StandardProfilingOptions['resource']>(value, 'resource', code)
	const lifecycle = readProfilingData<StandardProfilingOptions['lifecycle']>(value, 'lifecycle', code)
	return Object.freeze({clock, resource, lifecycle})
}
