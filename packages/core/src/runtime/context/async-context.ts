/**
 * @file AsyncLocalStorage context for correlation IDs and runtime context.
 * Requires Node.js ≥ 20.
 * Supports full RuntimeContext including traceId, spanId, tenantId, userId.
 */

import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'

import type {RuntimeContext} from '../../contracts/context'
import {isProxyObject} from '../../utils/safe-object'
import {captureNativePromiseResult, containNativePromiseUnchecked} from '../async/native-promise'

/**
 * Context stored in AsyncLocalStorage (same as RuntimeContext)
 */
type Context = RuntimeContext

const MAX_RUNTIME_CONTEXT_FIELD_LENGTH = 256
const CONTEXT_FIELDS = ['correlationId', 'traceId', 'spanId', 'tenantId', 'userId'] as const
const nativeReflectApply = Reflect.apply
const nativeObjectCreate = Object.create
const nativeObjectFreeze = Object.freeze
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const nativeAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore

/**
 * AsyncLocalStorage instance for context
 * Only available in Node.js ≥ 20
 */
let contextStorage: AsyncLocalStorage<Context> | undefined

/**
 * Get or create the context storage
 */
function getContextStorage() {
	if (!contextStorage) {
		contextStorage = new AsyncLocalStorage<Context>()
	}
	return contextStorage
}

function snapshotContext(context: unknown): Partial<Context> {
	const snapshot = nativeObjectCreate(null) as Partial<Context>
	containNativePromiseUnchecked(context)
	if (!context || typeof context !== 'object') return snapshot
	if (isProxyObject(context)) return snapshot
	try {
		for (let index = 0; index < CONTEXT_FIELDS.length; index += 1) {
			const field = CONTEXT_FIELDS[index]!
			const descriptor = nativeObjectGetOwnPropertyDescriptor(context, field)
			if (!descriptor || !('value' in descriptor)) continue
			const value = descriptor.value
			containNativePromiseUnchecked(value)
			if (typeof value === 'string' && value.length > 0
				&& value.length <= MAX_RUNTIME_CONTEXT_FIELD_LENGTH) snapshot[field] = value
		}
	} catch { return nativeObjectCreate(null) as Partial<Context> }
	return snapshot
}

function createContext(context: unknown): Context {
	const snapshot = snapshotContext(context)
	const result = nativeObjectCreate(null) as Context & Record<string, string>
	result.correlationId = snapshot.correlationId ?? randomUUID()
	for (let index = 1; index < CONTEXT_FIELDS.length; index += 1) {
		const field = CONTEXT_FIELDS[index]!
		const value = snapshot[field]
		if (value !== undefined) result[field] = value
	}
	return nativeObjectFreeze(result)
}

/**
 * Run a function with context (correlation ID and optional runtime context)
 * @param fn - Function to run
 * @param context - Optional runtime context (correlationId, traceId, spanId, tenantId, userId)
 * @returns Result of the function
 */
export function runWithContext<T>(
	fn: () => T,
	context?: Partial<RuntimeContext> & {correlationId?: string}
): T {
	containNativePromiseUnchecked(fn)
	const storage = getContextStorage()
	try {
		return nativeReflectApply(nativeAsyncLocalStorageRun, storage, [createContext(context), fn]) as T
	} catch(error) { containNativePromiseUnchecked(error); throw error }
}

/**
 * Run an async function with context (correlation ID and optional runtime context)
 * @param fn - Async function to run
 * @param context - Optional runtime context (correlationId, traceId, spanId, tenantId, userId)
 * @returns Result of the async function
 */
export async function runWithContextAsync<T>(
	fn: () => Promise<T>,
	context?: Partial<RuntimeContext> & {correlationId?: string}
): Promise<T> {
	containNativePromiseUnchecked(fn)
	const storage = getContextStorage()
	let result: Promise<T>
	try {
		result = nativeReflectApply(
			nativeAsyncLocalStorageRun, storage, [createContext(context), fn]
		) as Promise<T>
	} catch(error) { containNativePromiseUnchecked(error); throw error }
	const completion = captureNativePromiseResult<T>(result)
	if (!completion) throw new TypeError('Async context operation must return a native Promise')
	return await completion
}

/**
 * Get the current correlation ID from AsyncLocalStorage context
 * @returns Correlation ID if available, undefined otherwise
 */
export function getCorrelationId(): string | undefined {
	const storage = getContextStorage()
	const store = nativeReflectApply(nativeAsyncLocalStorageGetStore, storage, []) as Context | undefined
	return store?.correlationId
}

/**
 * Get the full runtime context from AsyncLocalStorage
 * @returns Runtime context if available, undefined otherwise
 */
export function getContext(): RuntimeContext | undefined {
	const storage = getContextStorage()
	const store = nativeReflectApply(nativeAsyncLocalStorageGetStore, storage, []) as Context | undefined
	if (!store) {
		return undefined
	}

	return snapshotContext(store) as RuntimeContext
}
