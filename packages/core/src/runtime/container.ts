/**
 * @file Dependency injection container.
 * Simple, explicit DI container for token-based service resolution.
 */

import {containNativePromiseUnchecked} from './async/native-promise'
import {
	deleteNativeMap,
	getNativeMap,
	hasNativeMap,
	setNativeMap
} from './collections/native-collections'

const NativeString = String
const NativeMap = Map
const nativeReflectApply = Reflect.apply

/**
 * Dependency injection container interface.
 * Provides explicit service registration and resolution via tokens.
 */
export interface Container {

	/**
	 * Bind a value to a token.
	 * @param token - Token symbol
	 * @param value - Value to bind
	 */
	bind<T>(token: symbol, value: T): void

	/**
	 * Remove a binding from a token.
	 * @param token - Token symbol
	 * @returns True when a binding was removed
	 */
	unbind?(token: symbol): boolean

	/**
	 * Get a value by token.
	 * Throws if token is not bound.
	 * @param token - Token symbol
	 * @returns Bound value
	 * @throws {Error} If token is not bound
	 */
	get<T>(token: symbol): T

	/**
	 * Try to get a value by token.
	 * Returns undefined if token is not bound.
	 * @param token - Token symbol
	 * @returns Bound value or undefined
	 */
	tryGet<T>(token: symbol): T | undefined

	/**
	 * Check if a token is bound.
	 * @param token - Token symbol
	 * @returns True if token is bound
	 */
	has(token: symbol): boolean
}

/**
 * Create a new dependency injection container.
 * @returns New container instance
 */
export function createContainer(): Container {

	const bindings = new NativeMap<symbol, unknown>()
	const requireToken = (token: unknown): symbol => {
		if (typeof token !== 'symbol') throw new TypeError('Container token must be a symbol')
		return token
	}

	return {
		bind<T>(token: symbol, value: T): void {
			// A binding is retained by the container. Observe a rejected native
			// Promise used as an opaque service value so the binding itself cannot
			// create a process-level unhandled rejection.
			containNativePromiseUnchecked(value)
			setNativeMap(bindings, requireToken(token), value)
		},

		unbind(token: symbol): boolean {
			return deleteNativeMap(bindings, requireToken(token))
		},

		get<T>(token: symbol): T {
			token = requireToken(token)
			const value = getNativeMap(bindings, token)
			if (value === undefined) {
				throw new Error(`Token ${nativeReflectApply(NativeString, undefined, [token]) as string} is not bound`)
			}
			return value as T
		},

		tryGet<T>(token: symbol): T | undefined {
			return getNativeMap(bindings, requireToken(token)) as T | undefined
		},

		has(token: symbol): boolean {
			return hasNativeMap(bindings, requireToken(token))
		}
	}
}
