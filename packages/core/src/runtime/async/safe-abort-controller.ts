import {isProxyObject} from '../../utils/safe-object'
import {
	addNativeSet,
	addNativeWeakSet,
	deleteNativeWeakSet,
	getNativeMap,
	getNativeWeakMap,
	hasNativeSet,
	hasNativeWeakMap,
	hasNativeWeakSet,
	pushNativeArray,
	setNativeMap,
	setNativeWeakMap,
	sizeNativeMap
} from '../collections/native-collections'

import {containNativePromiseUnchecked, isolateUnexpectedThenable} from './native-promise'

export {captureNativePromise, isolateUnexpectedThenable} from './native-promise'

type AbortListener = ((this: AbortSignal, event: Event) => unknown) | {handleEvent(event: Event): unknown}
type AddOptions = boolean | {capture?: boolean; once?: boolean; passive?: boolean; signal?: AbortSignal}
type RemoveOptions = boolean | {capture?: boolean}
const nativeAbort = AbortController.prototype.abort
const nativeArrayIsArray = Array.isArray
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectCreate = Object.create
const nativeObjectDefineProperty = Object.defineProperty
const nativeObjectDefineProperties = Object.defineProperties
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectPrototype = Object.prototype
const NativeAbortController = AbortController
const NativeMap = Map
const NativeSet = Set
const NativeWeakMap = WeakMap
const NativeWeakSet = WeakSet
const nativeReflectApply = Reflect.apply
const nativeAddEventListener = EventTarget.prototype.addEventListener
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener

/** Capture a synchronous data method without evaluating accessors. */
export function captureSyncMethod<TArguments extends unknown[], TResult>(
	owner: unknown,
	key: PropertyKey
): ((...args: TArguments) => TResult) | undefined {
	containNativePromiseUnchecked(key)
	if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null) return undefined
	if (isProxyObject(owner)) return undefined
	try {
		let current: object | null = owner
		const seen = new NativeSet<object>()
		isolateUnexpectedThenable(owner)
		for (let depth = 0; current && current !== nativeObjectPrototype
			&& !hasNativeSet(seen, current) && depth < 31; depth++) {
			if (isProxyObject(current)) return undefined
			addNativeSet(seen, current)
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if ('value' in descriptor) isolateUnexpectedThenable(descriptor.value)
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...args: TArguments) => TResult
				return (...args: TArguments) => {
					try { return nativeReflectApply(method, owner, args) as TResult }
					catch(error) { containNativePromiseUnchecked(error); throw error }
				}
			}
			current = nativeObjectGetPrototypeOf(current)
		}
	} catch(error) { containNativePromiseUnchecked(error) }
	return undefined
}

/** Clone a bounded plain-data graph without invoking accessors or iterators. */
export function snapshotBoundedDataGraph(value: unknown): unknown {
	type ArrayShape = {kind: 'array'; length: number; descriptors: PropertyDescriptor[]; invalid: boolean}
	type ObjectShape = {kind: 'object'; keys: string[]; descriptors: Map<string, PropertyDescriptor>; invalid: boolean}
	type ObservedShape = ArrayShape | ObjectShape
	let observedNodes = 0
	const observed = new NativeWeakSet<object>()
	const shapes = new NativeWeakMap<object, ObservedShape>()
	const observe = (candidate: unknown, depth: number): void => {
		if (isolateUnexpectedThenable(candidate) || candidate === null || typeof candidate !== 'object'
			|| hasNativeWeakSet(observed, candidate)) return
		addNativeWeakSet(observed, candidate)
		if (isProxyObject(candidate)) {
			setNativeWeakMap(shapes, candidate, {kind: 'object', keys: [], descriptors: new NativeMap(), invalid: true})
			return
		}
		if (depth > 8 || ++observedNodes > 4_096) {
			setNativeWeakMap(shapes, candidate, {kind: 'object', keys: [], descriptors: new NativeMap(), invalid: true})
			return
		}
		try {
			if (nativeArrayIsArray(candidate)) {
				const lengthDescriptor = nativeObjectGetOwnPropertyDescriptor(candidate, 'length')
				const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : 0
				const shape: ArrayShape = {kind: 'array', length, descriptors: [],
					invalid: !nativeNumberIsSafeInteger(length) || length < 0 || length > 256}
				setNativeWeakMap(shapes, candidate, shape)
				if (shape.invalid) return
				for (let index = 0; index < length; index++) {
					const descriptor = nativeObjectGetOwnPropertyDescriptor(candidate, index)
					if (!descriptor?.enumerable || !('value' in descriptor)) { shape.invalid = true; continue }
					pushNativeArray(shape.descriptors, descriptor)
					observe(descriptor.value, depth + 1)
				}
				return
			}
			const prototype = nativeObjectGetPrototypeOf(candidate)
			if (prototype !== nativeObjectPrototype && prototype !== null) {
				setNativeWeakMap(shapes, candidate, {kind: 'object', keys: [], descriptors: new NativeMap(), invalid: true})
				return
			}
			const shape: ObjectShape = {kind: 'object', keys: [], descriptors: new NativeMap(), invalid: false}
			setNativeWeakMap(shapes, candidate, shape)
			let scanned = 0
			for (const key in candidate) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(candidate, key)
				if (!descriptor) break
				if (++scanned > 64) { shape.invalid = true; return }
				if (shape.keys.length >= 64) { shape.invalid = true; return }
				if (!descriptor?.enumerable || !('value' in descriptor)) { shape.invalid = true; continue }
				pushNativeArray(shape.keys, key)
				setNativeMap(shape.descriptors, key, descriptor)
				observe(descriptor.value, depth + 1)
			}
		} catch(error) {
			containNativePromiseUnchecked(error)
			setNativeWeakMap(shapes, candidate, {kind: 'object', keys: [], descriptors: new NativeMap(), invalid: true})
		}
	}
	observe(value, 0)
	let nodes = 0
	const active = new NativeWeakSet<object>()
	const copies = new NativeWeakMap<object, unknown>()
	const snapshot = (candidate: unknown, depth: number): unknown => {
		if (isolateUnexpectedThenable(candidate)) throw new TypeError('Unsafe data graph')
		if (candidate === null || typeof candidate !== 'object') return candidate
		if (hasNativeWeakSet(active, candidate)) throw new TypeError('Unsafe data graph')
		if (hasNativeWeakMap(copies, candidate)) return getNativeWeakMap(copies, candidate)
		if (depth > 8 || ++nodes > 4_096) throw new TypeError('Unsafe data graph')
		addNativeWeakSet(active, candidate)
		try {
			if (nativeArrayIsArray(candidate)) {
				const shape = getNativeWeakMap(shapes, candidate)
				if (!shape || shape.kind !== 'array' || shape.invalid || shape.descriptors.length !== shape.length) {
					throw new TypeError('Unsafe data graph')
				}
				const result: unknown[] = []
				setNativeWeakMap(copies, candidate, result)
				for (let index = 0; index < shape.descriptors.length; index += 1) {
					pushNativeArray(result, snapshot(shape.descriptors[index]!.value, depth + 1))
				}
				return result
			}
			const shape = getNativeWeakMap(shapes, candidate)
			if (!shape || shape.kind !== 'object' || shape.invalid || sizeNativeMap(shape.descriptors) !== shape.keys.length) {
				throw new TypeError('Unsafe data graph')
			}
			const result = nativeObjectCreate(null) as Record<string, unknown>
			setNativeWeakMap(copies, candidate, result)
			for (let index = 0; index < shape.keys.length; index += 1) {
				const key = shape.keys[index]!
				const descriptor = getNativeMap(shape.descriptors, key)
				if (!descriptor) throw new TypeError('Unsafe data graph')
				result[key] = snapshot(descriptor.value, depth + 1)
			}
			return result
		} finally { deleteNativeWeakSet(active, candidate) }
	}
	try { return snapshot(value, 0) }
	catch(error) { containNativePromiseUnchecked(error); throw error }
}

/** Create a native AbortController whose listener failures cannot escape abort dispatch. */
export function createSafeAbortController(): AbortController {
	const controller = new NativeAbortController()
	const signal = controller.signal
	// Keep timeout ownership independent from later global prototype rewiring.
	// If abort can be replaced with a throwing method, a deadline callback may
	// never reach its authoritative rejection and leave delivery hanging.
	nativeObjectDefineProperty(controller, 'abort', {
		value: (reason?: unknown) => {
			containNativePromiseUnchecked(reason)
			return nativeReflectApply(nativeAbort, controller, [reason])
		},
		configurable: true
	})
	const add = (type: string, listener: AbortListener | null, options?: AddOptions): void => {
		containNativePromiseUnchecked(type)
		containNativePromiseUnchecked(listener)
		containNativePromiseUnchecked(options)
		nativeReflectApply(nativeAddEventListener, signal, [type, listener, options])
	}
	const remove = (type: string, listener: AbortListener | null, options?: RemoveOptions): void => {
		containNativePromiseUnchecked(type)
		containNativePromiseUnchecked(listener)
		containNativePromiseUnchecked(options)
		nativeReflectApply(nativeRemoveEventListener, signal, [type, listener, options])
	}
	const wrappers = new NativeWeakMap<AbortListener, AbortListener>()
	const wrap = (listener: AbortListener | null): AbortListener | null => {
		if (!listener) return listener
		let wrapped = getNativeWeakMap(wrappers, listener)
		if (!wrapped) {
			const callback = typeof listener === 'function'
				? (event: Event) => nativeReflectApply(listener, signal, [event])
				: captureSyncMethod<[Event], unknown>(listener, 'handleEvent')
			wrapped = (event) => {
				try {
					isolateUnexpectedThenable(callback?.(event))
				} catch(error) { containNativePromiseUnchecked(error) }
			}
			setNativeWeakMap(wrappers, listener, wrapped)
		}
		return wrapped
	}
	let onabort: AbortListener | null = null
	nativeObjectDefineProperties(signal, {
		addEventListener: {value(type: string, listener: AbortListener | null, options?: AddOptions) {
			add(type, wrap(listener), options)
		}},
		removeEventListener: {value(type: string, listener: AbortListener | null, options?: RemoveOptions) {
			remove(type, wrap(listener), options)
		}},
		onabort: {
			configurable: true,
			get: () => onabort,
			set(listener: unknown) {
				containNativePromiseUnchecked(listener)
				if (onabort) remove('abort', wrap(onabort))
				onabort = typeof listener === 'function' ? listener as AbortListener : null
				if (onabort) add('abort', wrap(onabort))
			}
		}
	})
	return controller
}
