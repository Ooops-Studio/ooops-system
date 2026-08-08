import {containNativePromiseUnchecked} from '../runtime/async/native-promise'
import {isProxyObject} from '../utils/safe-object'

import type {ResilienceExecutionContext, ResilienceMetadataValue} from './resilience-policy'

const CONTEXT_KEY_LIMIT = 7
const IDENTITY_KEYS = ['tenantId', 'workspaceId', 'userId', 'correlationId'] as const
const MAX_TIMESTAMP = 9_007_197_107_257_344
const nativeDateNow = Date.now.bind(Date)
const nativeReflectApply = Reflect.apply
const nativeArrayIsArray = Array.isArray
const nativeMathAbs = Math.abs
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectCreate = Object.create
const nativeObjectFreeze = Object.freeze
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectPrototype = Object.prototype
const nativeStringCharCodeAt = String.prototype.charCodeAt

function isContextKey(key: string): boolean {
	return key === 'resource' || key === 'operationKind' || key === 'tenantId'
		|| key === 'workspaceId' || key === 'userId' || key === 'correlationId'
		|| key === 'metadata'
}

function safeText(value: unknown, fallback: string, maximum: number): string {
	containNativePromiseUnchecked(value)
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return fallback
	for (let index = 0; index < value.length; index += 1) {
		const code = nativeReflectApply(nativeStringCharCodeAt, value, [index]) as number
		if (code <= 31 || code === 127) return fallback
	}
	return value
}

function safeTimestamp(value: unknown): number {
	containNativePromiseUnchecked(value)
	if (typeof value === 'number' && nativeNumberIsFinite(value) && nativeMathAbs(value) <= MAX_TIMESTAMP) return value
	try {
		const now = nativeDateNow()
		return nativeNumberIsFinite(now) && nativeMathAbs(now) <= MAX_TIMESTAMP ? now : 0
	} catch { return 0 }
}

function safeErrorOptions(value: unknown): ErrorOptions | undefined {
	containNativePromiseUnchecked(value)
	try {
		if (!value || typeof value !== 'object') return undefined
		if (isProxyObject(value)) return undefined
		const cause = nativeObjectGetOwnPropertyDescriptor(value, 'cause')
		if (!cause || !('value' in cause)) return undefined
		containNativePromiseUnchecked(cause.value)
		return {cause: cause.value}
	} catch { return undefined }
}

function freezeContext(context: ResilienceExecutionContext): ResilienceExecutionContext {
	containNativePromiseUnchecked(context)
	try {
		if (!context || typeof context !== 'object' || nativeArrayIsArray(context)) throw new Error()
		if (isProxyObject(context)) throw new Error()
		const prototype = nativeObjectGetPrototypeOf(context)
		if (prototype !== nativeObjectPrototype && prototype !== null) throw new Error()
		const values: Record<string, unknown> = nativeObjectCreate(null) as Record<string, unknown>
		let contextFields = 0
		let contextScanned = 0
		for (const key in context) {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(context, key)
			// `for...in` enumerates the receiver's own keys before walking its
			// prototype. Once no own descriptor exists, the bounded own-data snapshot
			// is complete; inherited pollution must not collapse tenant identity to the
			// shared "unknown" fallback.
			if (!descriptor) break
			if (++contextScanned > CONTEXT_KEY_LIMIT + 1) throw new Error()
			if (++contextFields > CONTEXT_KEY_LIMIT || !isContextKey(key)) throw new Error()
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			containNativePromiseUnchecked(descriptor.value)
			values[key] = descriptor.value
		}
		if (typeof values.resource !== 'string' || values.resource.length < 1 || values.resource.length > 128) throw new Error()
		const snapshot = nativeObjectCreate(null) as {
			resource: string
			operationKind?: string
			tenantId?: string
			workspaceId?: string
			userId?: string
			correlationId?: string
			metadata?: Readonly<Record<string, ResilienceMetadataValue>>
		}
		snapshot.resource = values.resource
		if (values.operationKind !== undefined) {
			if (typeof values.operationKind !== 'string' || values.operationKind.length < 1 || values.operationKind.length > 64) throw new Error()
			snapshot.operationKind = values.operationKind
		}
		for (let index = 0; index < IDENTITY_KEYS.length; index += 1) {
			const key = IDENTITY_KEYS[index]!
			const value = values[key]
			if (value === undefined) continue
			if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error()
			snapshot[key] = value
		}
		if (values.metadata !== undefined) {
			const metadata = values.metadata
			if (!metadata || typeof metadata !== 'object' || nativeArrayIsArray(metadata)) throw new Error()
			if (isProxyObject(metadata)) throw new Error()
			const metadataPrototype = nativeObjectGetPrototypeOf(metadata)
			if (metadataPrototype !== nativeObjectPrototype && metadataPrototype !== null) throw new Error()
			const metadataSnapshot = nativeObjectCreate(null) as Record<string, ResilienceMetadataValue>
			let metadataFields = 0
			let metadataScanned = 0
			for (const key in metadata) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(metadata, key)
				if (!descriptor) break
				if (++metadataScanned > 33) throw new Error()
				if (++metadataFields > 32 || key.length < 1 || key.length > 64) throw new Error()
				if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
				const value = descriptor.value
				containNativePromiseUnchecked(value)
				if (typeof value === 'string' && value.length <= 256 || typeof value === 'boolean' || typeof value === 'number' && nativeNumberIsFinite(value)) metadataSnapshot[key] = value
				else throw new Error()
			}
			snapshot.metadata = nativeObjectFreeze(metadataSnapshot)
		}
		return nativeObjectFreeze(snapshot)
	} catch {
		const fallback = nativeObjectCreate(null) as {resource: string}
		fallback.resource = 'unknown'
		return nativeObjectFreeze(fallback)
	}
}

export class ResilienceError extends Error {
	readonly context: ResilienceExecutionContext
	readonly timestamp: number
	readonly code: string

	constructor(
		message: string,
		context: ResilienceExecutionContext,
		code = 'RESILIENCE_FAILURE',
		timestamp?: number,
		options?: ErrorOptions
	) {
		containNativePromiseUnchecked(message)
		containNativePromiseUnchecked(code)
		containNativePromiseUnchecked(timestamp)
		containNativePromiseUnchecked(context)
		containNativePromiseUnchecked(options)
		super(safeText(message, 'Resilience operation failed', 1_024), safeErrorOptions(options))
		this.name = 'ResilienceError'
		this.context = freezeContext(context)
		this.code = safeText(code, 'RESILIENCE_FAILURE', 128)
		this.timestamp = safeTimestamp(timestamp)
	}
}

export class TimedOutError extends ResilienceError {
	readonly timeoutMs: number
	constructor(context: ResilienceExecutionContext, timeoutMs: number, timestamp?: number) {
		containNativePromiseUnchecked(timeoutMs)
		const safeTimeout = typeof timeoutMs === 'number' && nativeNumberIsSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647
			? timeoutMs : 0
		super(safeTimeout > 0 ? `Operation timed out after ${safeTimeout}ms` : 'Operation timed out', context, 'RESILIENCE_TIMEOUT', timestamp)
		this.name = 'TimedOutError'
		this.timeoutMs = safeTimeout
	}
}

export class BreakerOpenError extends ResilienceError {
	constructor(context: ResilienceExecutionContext, timestamp?: number) {
		super('Circuit breaker is open', context, 'RESILIENCE_BREAKER_OPEN', timestamp)
		this.name = 'BreakerOpenError'
	}
}

export class BulkheadOverflowError extends ResilienceError {
	constructor(context: ResilienceExecutionContext, timestamp?: number) {
		super('Bulkhead capacity exceeded', context, 'RESILIENCE_BULKHEAD_OVERFLOW', timestamp)
		this.name = 'BulkheadOverflowError'
	}
}

export class RetryExhaustedError extends ResilienceError {
	constructor(context: ResilienceExecutionContext, cause: unknown, timestamp?: number) {
		super('Retry policy exhausted', context, 'RESILIENCE_RETRY_EXHAUSTED', timestamp, {cause})
		this.name = 'RetryExhaustedError'
	}
}

export class ResilienceConfigurationError extends Error {
	readonly code: string
	constructor(code: string, message: string) {
		containNativePromiseUnchecked(code)
		containNativePromiseUnchecked(message)
		super(safeText(message, 'Invalid resilience configuration', 1_024))
		this.name = 'ResilienceConfigurationError'
		this.code = safeText(code, 'RESILIENCE_INVALID_CONFIG', 128)
	}
}
