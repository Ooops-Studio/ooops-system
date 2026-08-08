/**
 * @file AsyncLocalStorage abstraction for tracing context.
 * Provides a generic AsyncContextStore interface that can be used by tracing service
 * to manage span context without coupling to AsyncLocalStorage specifics.
 */

import {AsyncLocalStorage} from 'node:async_hooks'

import {containNativePromiseUnchecked} from '../async/native-promise'

const nativeReflectApply = Reflect.apply
const nativeAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const nativeAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore

/**
 * Generic async context store interface.
 * Abstracts over AsyncLocalStorage for testability and portability.
 */
export interface AsyncContextStore<T> {

	/**
	 * Run a function with a context value.
	 * The context is available via get() within the function and all async operations it triggers.
	 * @param value - Context value to store
	 * @param fn - Function to run with the context
	 * @returns Result of the function
	 */
	run<R>(value: T, fn: () => R | Promise<R>): R | Promise<R>

	/**
	 * Get the current context value (if any).
	 * Returns undefined if no context is active.
	 * @returns Current context value or undefined
	 */
	get(): T | undefined
}

/**
 * Create an AsyncLocalStorage-backed context store.
 * @template T - Type of context value
 * @returns AsyncContextStore instance
 */
export function createAsyncContextStore<T = unknown>(): AsyncContextStore<T> {
	const storage = new AsyncLocalStorage<T>()

	return {
		run<R>(value: T, fn: () => R | Promise<R>): R | Promise<R> {
			// Context values are opaque, but a rejected native Promise still owns an
			// independent rejection lifecycle. Storing one without observing it can
			// terminate Node.js under strict unhandled-rejection semantics.
			containNativePromiseUnchecked(value)
			containNativePromiseUnchecked(fn)
			try {
				return nativeReflectApply(nativeAsyncLocalStorageRun, storage, [value, fn]) as R | Promise<R>
			} catch(error) { containNativePromiseUnchecked(error); throw error }
		},
		get(): T | undefined {
			return nativeReflectApply(nativeAsyncLocalStorageGetStore, storage, []) as T | undefined
		}
	}
}
