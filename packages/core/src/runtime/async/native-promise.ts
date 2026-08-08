import {hasSafePrototypeChain, isProxyObject} from '../../utils/safe-object'
import {addNativeWeakSet, hasNativeWeakSet} from '../collections/native-collections'

const nativeReflectApply = Reflect.apply
const nativeArrayIsArray = Array.isArray
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeRegExpTest = RegExp.prototype.test
const nativeObjectDefineProperties = Object.defineProperties
const nativeObjectFreeze = Object.freeze
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativePromisePrototype = Promise.prototype
const nativePromiseThen = Promise.prototype.then
const NativePromise = Promise
const functionToString = Function.prototype.toString
const nativePromiseConstructorDescriptor = nativeObjectGetOwnPropertyDescriptor(
	nativePromisePrototype, 'constructor'
)
const nativePromiseSpeciesDescriptor = nativeObjectGetOwnPropertyDescriptor(NativePromise, Symbol.species)
const ownedNativePromises = new WeakSet<object>()
const containedNativePromises = new WeakSet<object>()
const safePromiseSpecies = nativeObjectFreeze({[Symbol.species]: NativePromise})
const NATIVE_PROMISE_SOURCE = /^function Promise\(\) \{ \[native code\] \}$/u
const NATIVE_SPECIES_GETTER_SOURCE = /^function get \[Symbol\.species\]\(\) \{ \[native code\] \}$/u
const MAX_NATIVE_PROMISE_RACE_VALUES = 4_096

function isSafeResolutionValue(value: unknown): boolean {
	if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return true
	if (!hasSafePrototypeChain(value)) return false
	let current: object | null = value as object
	try {
		for (let depth = 0; current && depth < 32; depth += 1) {
			if (isProxyObject(current)) return false
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, 'then')
			if (descriptor) return 'value' in descriptor && typeof descriptor.value !== 'function'
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return false }
	return current === null
}

function resolveSafeValue<T>(resolve: (value: T) => void, reject: (reason?: unknown) => void, value: T): void {
	if (!isSafeResolutionValue(value)) {
		containNativePromiseUnchecked(value)
		reject(new TypeError('Native promise resolved to an unsafe thenable value'))
		return
	}
	resolve(value)
}

function hasIntactNativePromiseSpecies(): boolean {
	try {
		const constructor = nativeObjectGetOwnPropertyDescriptor(nativePromisePrototype, 'constructor')
		const species = nativeObjectGetOwnPropertyDescriptor(NativePromise, Symbol.species)
		return constructor?.value === nativePromiseConstructorDescriptor?.value
			&& constructor?.get === nativePromiseConstructorDescriptor?.get
			&& constructor?.set === nativePromiseConstructorDescriptor?.set
			&& species?.value === nativePromiseSpeciesDescriptor?.value
			&& species?.get === nativePromiseSpeciesDescriptor?.get
			&& species?.set === nativePromiseSpeciesDescriptor?.set
	} catch { return false }
}

function hasSafeCrossRealmPromiseSpecies(constructor: Function): boolean {
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(constructor, Symbol.species)
		if (!descriptor || typeof descriptor.get !== 'function' || descriptor.set !== undefined) return false
		if (isProxyObject(descriptor.get)) return false
		return nativeReflectApply(nativeRegExpTest, NATIVE_SPECIES_GETTER_SOURCE, [
			nativeReflectApply(functionToString, descriptor.get, [])
		]) as boolean
	} catch { return false }
}

/** Allocate an owned promise without consulting a subsequently replaced global. */
export function createNativePromise<T>(
	executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void
): Promise<T> {
	containNativePromiseUnchecked(executor)
	const promise = new NativePromise<T>((resolve, reject) => {
		const rejectSafely = (reason?: unknown): void => {
			// A rejected native Promise used as a rejection reason remains an
			// independently unhandled rejection unless it is explicitly consumed.
			containNativePromiseUnchecked(reason)
			reject(reason)
		}
		try { executor(resolve, rejectSafely) }
		catch(error) { rejectSafely(error) }
	})
	// Promise.prototype.then dynamically consults the receiver's constructor and
	// species. Pin owned promises to the captured constructor so later prototype
	// rewiring cannot break cleanup or authoritative delivery races.
	nativeObjectDefineProperties(promise, {
		constructor: {value: safePromiseSpecies},
		// Await treats a promise with a non-default constructor as a thenable and
		// performs a property lookup. Pin that lookup too, otherwise a late
		// Promise.prototype.then replacement can detach an ownership barrier.
		then: {value: (
			onFulfilled?: ((value: T) => unknown) | null,
			onRejected?: ((reason: unknown) => unknown) | null
		) => nativeReflectApply(nativePromiseThen, promise, [onFulfilled, onRejected])}
	})
	addNativeWeakSet(ownedNativePromises, promise)
	return promise
}

/** Race owned native promises without consulting Promise.race or array iterators. */
export function raceNativePromises<T>(values: readonly Promise<T>[]): Promise<T> {
	containNativePromiseUnchecked(values)
	return createNativePromise<T>((resolve, reject) => {
		if (isProxyObject(values) || !nativeArrayIsArray(values)) {
			reject(new TypeError('Native promise race values must be an Array'))
			return
		}
		const lengthDescriptor = nativeObjectGetOwnPropertyDescriptor(values, 'length')
		const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : -1
		if (!nativeNumberIsSafeInteger(length) || length < 0 || length > MAX_NATIVE_PROMISE_RACE_VALUES) {
			reject(new RangeError(`Native promise race supports at most ${MAX_NATIVE_PROMISE_RACE_VALUES} values`))
			return
		}
		for (let index = 0; index < length; index += 1) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(values, index)
			if (descriptor && 'value' in descriptor) containNativePromiseUnchecked(descriptor.value)
		}
		for (let index = 0; index < length; index += 1) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(values, index)
			if (!descriptor || !('value' in descriptor) || !isNativePromise(descriptor.value)) {
				reject(new TypeError('Native promise race values must be dense native Promises'))
				return
			}
			try {
				nativeReflectApply(nativePromiseThen, descriptor.value, [
					(value: T) => resolveSafeValue(resolve, reject, value), reject
				])
			}
			catch(error) { containNativePromiseUnchecked(error); reject(error); return }
		}
	})
}

/** Transform an owned/adopted native promise without reading instance methods. */
export function mapNativePromise<T, TResult>(
	value: Promise<T>,
	onFulfilled: (result: T) => TResult,
	onRejected: (error: unknown) => TResult
): Promise<TResult> {
	containNativePromiseUnchecked(value)
	containNativePromiseUnchecked(onFulfilled)
	containNativePromiseUnchecked(onRejected)
	return createNativePromise<TResult>((resolve, reject) => {
		if (!isNativePromise(value)) {
			reject(new TypeError('Native promise mapping requires a native Promise'))
			return
		}
		try {
			nativeReflectApply(nativePromiseThen, value, [
				(result: T) => {
					try { resolveSafeValue(resolve, reject, onFulfilled(result)) } catch(error) { reject(error) }
				},
				(error: unknown) => {
					try { resolveSafeValue(resolve, reject, onRejected(error)) } catch(handlerError) { reject(handlerError) }
				}
			])
		} catch(error) { containNativePromiseUnchecked(error); reject(error) }
	})
}

/** Invoke a native-promise operation on a microtask and adopt it intrinsically. */
export function deferNativePromise<T>(operation: () => Promise<T>): Promise<T> {
	containNativePromiseUnchecked(operation)
	const start = createNativePromise<void>((resolve) => { resolve() })
	return createNativePromise<T>((resolve, reject) => {
		try {
			nativeReflectApply(nativePromiseThen, start, [
				() => {
					try {
						const completion = operation()
						if (!isNativePromise(completion)) {
							reject(new TypeError('Deferred operation must return a native Promise'))
							return
						}
						nativeReflectApply(nativePromiseThen, completion, [
							(value: T) => resolveSafeValue(resolve, reject, value), reject
						])
					} catch(error) { reject(error) }
				},
				reject
			])
		} catch(error) { containNativePromiseUnchecked(error); reject(error) }
	})
}

export function containNativePromiseUnchecked(value: unknown): void {
	if (!isNativePromise(value)) return
	if (hasNativeWeakSet(containedNativePromises, value as object)) return
	addNativeWeakSet(containedNativePromises, value as object)
	try {
		nativeReflectApply(nativePromiseThen, value, [() => undefined, (reason: unknown) => {
			// Rejection reasons are arbitrary values. A rejected native Promise used
			// as the reason has its own rejection lifecycle and must be consumed too.
			containNativePromiseUnchecked(reason)
		}])
	}
	catch { /* the value is not a native promise */ }
}

function isNativePromise(value: unknown): value is Promise<unknown> {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
	if (isProxyObject(value)) return false
	try {
		if (hasNativeWeakSet(ownedNativePromises, value as object)) return true
		if (nativeObjectGetOwnPropertyDescriptor(value, 'constructor') !== undefined) return false
		const prototype = nativeObjectGetPrototypeOf(value)
		if (prototype === nativePromisePrototype) return hasIntactNativePromiseSpecies()
		if (!prototype || isProxyObject(prototype)) return false
		const constructor = nativeObjectGetOwnPropertyDescriptor(prototype, 'constructor')
		if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function') return false
		if (isProxyObject(constructor.value)) return false
		const constructorPrototype = nativeObjectGetOwnPropertyDescriptor(constructor.value, 'prototype')
		if (!constructorPrototype || !('value' in constructorPrototype) || constructorPrototype.value !== prototype) return false
		return nativeReflectApply(nativeRegExpTest, NATIVE_PROMISE_SOURCE, [
			nativeReflectApply(functionToString, constructor.value, [])
		]) as boolean && hasSafeCrossRealmPromiseSpecies(constructor.value)
	} catch { return false }
}

/** Consume genuine native promises without executing caller-defined thenable methods. */
export function isolateUnexpectedThenable(value: unknown, onRejected: (error: unknown) => void = () => undefined): boolean {
	containNativePromiseUnchecked(onRejected)
	if (!isNativePromise(value)) return false
	try {
		nativeReflectApply(nativePromiseThen, value, [() => undefined, (error: unknown) => {
			containNativePromiseUnchecked(error)
			try { isolateUnexpectedThenable(onRejected(error)) }
			catch(observerError) { containNativePromiseUnchecked(observerError) }
		}])
		return true
	} catch(error) { containNativePromiseUnchecked(error) }
	return false
}

/** Observe both outcomes of a genuine native promise through captured intrinsics. */
export function observeNativePromiseSettlement<T = void>(
	value: unknown,
	onFulfilled: (result: T) => void,
	onRejected: (error: unknown) => void
): boolean {
	containNativePromiseUnchecked(onFulfilled)
	containNativePromiseUnchecked(onRejected)
	if (!isNativePromise(value)) return false
	try {
		nativeReflectApply(nativePromiseThen, value, [
			(result: unknown) => {
				try { isolateUnexpectedThenable(onFulfilled(result as T)) }
				catch(error) { containNativePromiseUnchecked(error) }
			},
			(error: unknown) => {
				containNativePromiseUnchecked(error)
				try { isolateUnexpectedThenable(onRejected(error)) }
				catch(observerError) { containNativePromiseUnchecked(observerError) }
			}
		])
		return true
	} catch(error) { containNativePromiseUnchecked(error); return false }
}

/** Adopt a genuine native promise into an uncontaminated completion promise. */
export function captureNativePromise(value: unknown): Promise<void> | undefined {
	if (!isNativePromise(value)) return undefined
	return createNativePromise<void>((resolve, reject) => {
		try { nativeReflectApply(nativePromiseThen, value, [() => resolve(), reject]) }
		catch(error) { containNativePromiseUnchecked(error); reject(error) }
	})
}

/** Adopt a genuine native promise value without reading its caller-owned `then` property. */
export function captureNativePromiseResult<T>(value: unknown): Promise<T> | undefined {
	if (!isNativePromise(value)) return undefined
	return createNativePromise<T>((resolve, reject) => {
		try {
			nativeReflectApply(nativePromiseThen, value, [
				(result: unknown) => resolveSafeValue(resolve, reject, result as T), reject
			])
		} catch(error) { containNativePromiseUnchecked(error); reject(error) }
	})
}
