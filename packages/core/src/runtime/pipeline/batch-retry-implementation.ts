import {AsyncLocalStorage} from 'node:async_hooks'

import {exponentialBackoff} from '../../utils/async/backoff'
import {byteSize} from '../../utils/byte-size'
import {hasSafePrototypeChain, isProxyObject} from '../../utils/safe-object'
import {
	captureNativePromiseResult,
	containNativePromiseUnchecked,
	createNativePromise,
	deferNativePromise,
	mapNativePromise,
	raceNativePromises
} from '../async/native-promise'
import {
	captureSyncMethod,
	createSafeAbortController,
	isolateUnexpectedThenable
} from '../async/safe-abort-controller'
import {
	addNativeSet,
	addNativeWeakSet,
	deleteNativeMap,
	deleteNativeSet,
	getNativeMap,
	hasNativeWeakSet,
	pushNativeArray,
	setNativeMap,
	sliceNativeArray,
	spliceNativeArray,
	snapshotNativeSet
} from '../collections/native-collections'

import {createBatchRetryTracking} from './batch-retry-tracking'
import type {
	BatchingPolicy,
	BatchRetryPipeline,
	BatchRetryPipelineOptions,
	BatchRetrySendResult,
	RetryPolicy,
	TelemetryHooks
} from './batch-retry-types'

const ATTEMPT_TIMEOUT_ABORT_GRACE_MS = 50
const MAX_BATCH_ITEMS = 10_000
const MAX_BATCH_BYTES = 100_000_000
const MAX_RETRY_ATTEMPTS = 100
const MAX_TIMER_MS = 2_147_483_647
const RETRY_DECISION_FIELDS = ['code', 'nonRetryable', 'retryable', 'ambiguousDelivery'] as const
const nativeArrayIsArray = Array.isArray
const nativeMathMax = Math.max
const nativeNumberIsFinite = Number.isFinite
const nativeNumberIsSafeInteger = Number.isSafeInteger
const nativeObjectAssign = Object.assign
const nativeObjectCreate = Object.create
const nativeObjectFreeze = Object.freeze
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const NativeMap = Map
const NativeSet = Set
const NativeWeakSet = WeakSet
const nativeObjectPrototype = Object.prototype
const nativeReflectApply = Reflect.apply
const nativeAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const nativeAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore
const nativeAbortSignalAborted = nativeObjectGetOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
const nativeAbortSignalReason = nativeObjectGetOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get

interface AbortSignalCapability {
	aborted(): boolean
	reason(): unknown
	add(listener: () => void): void
	remove(listener: () => void): void
}

function ownDataField(value: unknown, key: PropertyKey): unknown {
	containNativePromiseUnchecked(value)
	if (!value || typeof value !== 'object') return undefined
	if (isProxyObject(value)) throw new TypeError('Batch retry configuration must not be a Proxy')
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = nativeObjectGetOwnPropertyDescriptor(value, key) } catch {
		throw new TypeError('Batch retry configuration cannot be inspected safely')
	}
	if (!descriptor) return undefined
	if (!('value' in descriptor)) throw new TypeError('Batch retry configuration must use data properties')
	containNativePromiseUnchecked(descriptor.value)
	return descriptor.value
}

function snapshotBatchingPolicy(value: unknown): Readonly<BatchingPolicy> {
	return nativeObjectFreeze({
		maxBatch: ownDataField(value, 'maxBatch') as number,
		maxIntervalMs: ownDataField(value, 'maxIntervalMs') as number,
		maxBytes: ownDataField(value, 'maxBytes') as number
	})
}

function snapshotRetryPolicy(value: unknown): Readonly<RetryPolicy> {
	return nativeObjectFreeze({
		maxAttempts: ownDataField(value, 'maxAttempts') as number,
		baseDelayMs: ownDataField(value, 'baseDelayMs') as number,
		multiplier: ownDataField(value, 'multiplier') as number,
		maxDelayMs: ownDataField(value, 'maxDelayMs') as number,
		jitter: ownDataField(value, 'jitter') as number,
		attemptTimeoutMs: ownDataField(value, 'attemptTimeoutMs') as number
	})
}

function captureTelemetryMethod(
	telemetry: object,
	key: keyof TelemetryHooks
): ((...args: unknown[]) => unknown) | undefined {
	let current: object | null = telemetry
	for (let depth = 0; current && current !== nativeObjectPrototype && depth < 16; depth += 1) {
		if (isProxyObject(current)) throw new TypeError('Invalid batch retry telemetry')
		const descriptor = nativeObjectGetOwnPropertyDescriptor(current, key)
		if (descriptor) {
			if (!('value' in descriptor)) throw new TypeError('Batch retry telemetry must use data methods')
			containNativePromiseUnchecked(descriptor.value)
			if (descriptor.value === undefined) return undefined
			if (typeof descriptor.value !== 'function') throw new TypeError('Batch retry telemetry hooks must be functions')
			const method = descriptor.value as (...args: unknown[]) => unknown
			return (...args: unknown[]) => nativeReflectApply(method, telemetry, args)
		}
		current = nativeObjectGetPrototypeOf(current) as object | null
	}
	return undefined
}

function snapshotTelemetry(value: unknown): Readonly<TelemetryHooks> | undefined {
	if (value === undefined) return undefined
	if (isolateUnexpectedThenable(value)) throw new TypeError('Invalid batch retry telemetry')
	if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxyObject(value)) {
		throw new TypeError('Invalid batch retry telemetry')
	}
	const onMark = captureTelemetryMethod(value, 'onMark') as TelemetryHooks['onMark']
	const onDropped = captureTelemetryMethod(value, 'onDropped') as TelemetryHooks['onDropped']
	const onError = captureTelemetryMethod(value, 'onError') as TelemetryHooks['onError']
	const onSuccess = captureTelemetryMethod(value, 'onSuccess') as TelemetryHooks['onSuccess']
	const snapshot = nativeObjectCreate(null) as TelemetryHooks
	if (onMark) snapshot.onMark = onMark
	if (onDropped) snapshot.onDropped = onDropped
	if (onError) snapshot.onError = onError
	if (onSuccess) snapshot.onSuccess = onSuccess
	return nativeObjectFreeze(snapshot)
}

function snapshotAbortSignal(value: unknown): AbortSignalCapability | undefined {
	if (value === undefined) return undefined
	if (isolateUnexpectedThenable(value)) throw new TypeError('Invalid batch retry abort signal')
	if (!value || typeof value !== 'object' || isProxyObject(value)
		|| !nativeAbortSignalAborted || !nativeAbortSignalReason) {
		throw new TypeError('Invalid batch retry abort signal')
	}
	try { nativeReflectApply(nativeAbortSignalAborted, value, []) } catch {
		throw new TypeError('Invalid batch retry abort signal')
	}
	const captureMethod = (key: 'addEventListener' | 'removeEventListener') => {
		let current: object | null = value
		for (let depth = 0; current && current !== nativeObjectPrototype && depth < 16; depth += 1) {
			if (isProxyObject(current)) throw new TypeError('Invalid batch retry abort signal')
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, key)
			if (descriptor) {
				if ('value' in descriptor) containNativePromiseUnchecked(descriptor.value)
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
					throw new TypeError('Invalid batch retry abort signal')
				}
				const method = descriptor.value as (...args: unknown[]) => unknown
				return (...args: unknown[]) => {
					try {
						const result = nativeReflectApply(method, value, args)
						isolateUnexpectedThenable(result)
						return result
					} catch(error) { containNativePromiseUnchecked(error); throw error }
				}
			}
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
		throw new TypeError('Invalid batch retry abort signal')
	}
	const add = captureMethod('addEventListener')
	const remove = captureMethod('removeEventListener')
	return nativeObjectFreeze({
		aborted: () => nativeReflectApply(nativeAbortSignalAborted, value, []) as boolean,
		reason: () => nativeReflectApply(nativeAbortSignalReason, value, []),
		add: (listener: () => void) => { add('abort', listener, {once: true}) },
		remove: (listener: () => void) => { remove('abort', listener) }
	})
}

export function createBatchRetryPipeline<T>(
	options: BatchRetryPipelineOptions<T>
): BatchRetryPipeline<T> {
	if (isolateUnexpectedThenable(options)) throw new TypeError('Invalid batch retry options')
	const batching = snapshotBatchingPolicy(ownDataField(options, 'batching'))
	const retry = snapshotRetryPolicy(ownDataField(options, 'retry'))
	const send = ownDataField(options, 'send') as BatchRetryPipelineOptions<T>['send']
	const sendWithSignal = ownDataField(options, 'sendWithSignal') as BatchRetryPipelineOptions<T>['sendWithSignal']
	const getRetryItems = ownDataField(options, 'getRetryItems') as BatchRetryPipelineOptions<T>['getRetryItems']
	const prepareItems = ownDataField(options, 'prepareItems') as BatchRetryPipelineOptions<T>['prepareItems']
	const onAmbiguousFailure = ownDataField(options, 'onAmbiguousFailure') as BatchRetryPipelineOptions<T>['onAmbiguousFailure']
	const configuredGetItemSize = ownDataField(options, 'getItemSize') as BatchRetryPipelineOptions<T>['getItemSize']
	const getItemSize = configuredGetItemSize ?? ((item: T) => {
		// Default: try to calculate size if item is string-like
		if (typeof item === 'string') {
			return byteSize(item)
		}
		// Fallback: rough estimate
		return 500
	})
	const telemetry = snapshotTelemetry(ownDataField(options, 'telemetry'))
	const signal = snapshotAbortSignal(ownDataField(options, 'signal'))
	const configuredNoRetry = ownDataField(options, 'noRetry')
	if (configuredNoRetry !== undefined && typeof configuredNoRetry !== 'boolean') {
		throw new TypeError('Invalid batch retry noRetry option')
	}
	const noRetry = configuredNoRetry ?? false
	if (!batching || !nativeNumberIsSafeInteger(batching.maxBatch) || batching.maxBatch <= 0
		|| batching.maxBatch > MAX_BATCH_ITEMS || !nativeNumberIsSafeInteger(batching.maxBytes)
		|| batching.maxBytes <= 0 || batching.maxBytes > MAX_BATCH_BYTES
		|| !nativeNumberIsSafeInteger(batching.maxIntervalMs) || batching.maxIntervalMs <= 0
		|| batching.maxIntervalMs > MAX_TIMER_MS) {
		throw new TypeError('Invalid batch retry batching policy')
	}
	if (!retry || !nativeNumberIsSafeInteger(retry.maxAttempts) || retry.maxAttempts <= 0
		|| retry.maxAttempts > MAX_RETRY_ATTEMPTS || !nativeNumberIsFinite(retry.baseDelayMs)
		|| retry.baseDelayMs < 0 || retry.baseDelayMs > MAX_TIMER_MS
		|| !nativeNumberIsFinite(retry.multiplier) || retry.multiplier <= 0
		|| !nativeNumberIsFinite(retry.maxDelayMs) || retry.maxDelayMs < 0
		|| retry.maxDelayMs > MAX_TIMER_MS || !nativeNumberIsFinite(retry.jitter)
		|| retry.jitter < 0 || retry.jitter > 1 || !nativeNumberIsSafeInteger(retry.attemptTimeoutMs)
		|| retry.attemptTimeoutMs <= 0 || retry.attemptTimeoutMs > MAX_TIMER_MS) {
		throw new TypeError('Invalid batch retry policy')
	}
	if (typeof send !== 'function' || (sendWithSignal !== undefined && typeof sendWithSignal !== 'function')
		|| (getRetryItems !== undefined && typeof getRetryItems !== 'function')
		|| (prepareItems !== undefined && typeof prepareItems !== 'function')
		|| (onAmbiguousFailure !== undefined && typeof onAmbiguousFailure !== 'function')
		|| typeof getItemSize !== 'function') {
		throw new TypeError('Invalid batch retry integration')
	}
	// Timer ownership is part of the delivery barrier. Capture both capabilities
	// before any integration can run so a sender/observer cannot replace the
	// globals and strand a retry backoff or remove a later attempt deadline.
	const ownedSetTimeout = globalThis.setTimeout
	const ownedClearTimeout = globalThis.clearTimeout
	const scheduleTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
		try {
			const timer = nativeReflectApply(ownedSetTimeout, globalThis, [callback, delayMs])
			if (isolateUnexpectedThenable(timer)) throw new TypeError('Batch retry timer must be allocated synchronously')
			return timer as ReturnType<typeof setTimeout>
		} catch(error) { containNativePromiseUnchecked(error); throw error }
	}
	const cancelTimer = (timer: ReturnType<typeof setTimeout>): boolean => {
		const result = nativeReflectApply(ownedClearTimeout, globalThis, [timer])
		return !isolateUnexpectedThenable(result)
	}

	let batch: T[] = []
	let batchBytes = 0
	let admissionId = 0
	let batchFirstAdmissionId = 0
	let flushTimer: ReturnType<typeof setTimeout> | undefined
	let activeFlush: Promise<void> | undefined
	let activeFlushFirstAdmissionId = 0
	let closePromise: Promise<void> | undefined
	let closing = false
	let closed = false
	let invokingIntegration = false
	const integrationContext = new AsyncLocalStorage<boolean>()
	let explicitBarrierDepth = 0
	const deliveryTimers = new NativeSet<ReturnType<typeof setTimeout>>()
	const invokeTimerMethod = (
		timer: ReturnType<typeof setTimeout>,
		key: 'ref' | 'unref'
	): void => {
		try {
			const method = captureSyncMethod<[], unknown>(timer, key)
			if (method) isolateUnexpectedThenable(method())
		} catch(error) { containNativePromiseUnchecked(error) }
	}
	const clearTimerSafely = (timer: ReturnType<typeof setTimeout> | undefined): void => {
		if (!timer) return
		try {
			if (cancelTimer(timer)) return
		} catch(error) {
			containNativePromiseUnchecked(error)
		}
		// A failed or asynchronous cancellation cannot prove that logical timer
		// ownership ended. Detach the handle so it cannot retain the process.
		invokeTimerMethod(timer, 'unref')
	}
	const trackDeliveryTimer = (timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
		addNativeSet(deliveryTimers, timer)
		if (explicitBarrierDepth === 0) {
			invokeTimerMethod(timer, 'unref')
		}
		return timer
	}
	const clearDeliveryTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
		if (!timer) return
		clearTimerSafely(timer)
		deleteNativeSet(deliveryTimers, timer)
	}
	const runExplicitBarrier = async(operation: () => Promise<void>): Promise<void> => {
		explicitBarrierDepth += 1
		try {
			const activeTimers = snapshotNativeSet(deliveryTimers)
			for (let index = 0; index < activeTimers.length; index += 1) {
				const timer = activeTimers[index]!
				invokeTimerMethod(timer, 'ref')
			}
			await operation()
		} finally {
			explicitBarrierDepth -= 1
			if (explicitBarrierDepth === 0) {
				const activeTimers = snapshotNativeSet(deliveryTimers)
				for (let index = 0; index < activeTimers.length; index += 1) {
					const timer = activeTimers[index]!
					invokeTimerMethod(timer, 'unref')
				}
			}
		}
	}
	const trackedPendingAmbiguousErrors = new NativeWeakSet<object>()
	const invokeIntegration = <TResult>(callback: () => TResult): TResult => {
		invokingIntegration = true
		try {
			return nativeReflectApply(
				nativeAsyncLocalStorageRun, integrationContext, [true, callback]
			) as TResult
		} catch(error) {
			containNativePromiseUnchecked(error)
			throw error
		} finally { invokingIntegration = false }
	}
	const invokeSynchronousIntegration = <TResult>(callback: () => TResult, label: string): TResult => {
		const result = invokeIntegration(callback)
		if (isolateUnexpectedThenable(result)) throw new TypeError(`${label} must return synchronously`)
		return result
	}
	const isIntegrationInvocation = (): boolean => {
		if (invokingIntegration) return true
		try {
			return nativeReflectApply(
				nativeAsyncLocalStorageGetStore, integrationContext, []
			) === true
		} catch { return true }
	}
	const invokeTelemetry = (callback: () => unknown): void => {
		try { isolateUnexpectedThenable(invokeIntegration(callback)) } catch { /* Observer failures are isolated. */ }
	}
	const markSafely = (...args: Parameters<NonNullable<NonNullable<typeof telemetry>['onMark']>>): void => {
		invokeTelemetry(() => telemetry?.onMark?.(...args))
	}
	const droppedSafely = (...args: Parameters<NonNullable<NonNullable<typeof telemetry>['onDropped']>>): void => {
		invokeTelemetry(() => telemetry?.onDropped?.(...args))
	}
	const errorSafely = (error: unknown): void => {
		invokeTelemetry(() => telemetry?.onError?.(error))
	}
	const successSafely = (count?: number): void => {
		invokeTelemetry(() => telemetry?.onSuccess?.(count))
	}
	const planFlush = () => {
		if (flushTimer) return
		try {
			let fired = false
			const timer = scheduleTimer(() => {
				fired = true
				flushTimer = undefined
				void flush()
			}, batching.maxIntervalMs)
			if (fired) clearTimerSafely(timer)
			else {
				flushTimer = timer
				invokeTimerMethod(flushTimer, 'unref')
			}
		} catch(error) {
			clearTimerSafely(flushTimer)
			flushTimer = undefined
			errorSafely(error)
			// Timer allocation is only a scheduling optimization. Claim the batch
			// immediately so an admitted record cannot become permanently stranded.
			void flush()
		}
	}
	const readDataProperty = (value: unknown, key: PropertyKey): unknown => {
		if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
		if (isProxyObject(value)) return undefined
		try {
			const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
			if (!descriptor || !('value' in descriptor)) return undefined
			containNativePromiseUnchecked(descriptor.value)
			return descriptor.value
		} catch { return undefined }
	}
	const snapshotSubset = (value: unknown, allowed: readonly T[]): readonly T[] | undefined => {
		if (isProxyObject(value) || !nativeArrayIsArray(value)) return undefined
		try {
			const lengthDescriptor = nativeObjectGetOwnPropertyDescriptor(value, 'length')
			const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
			if (!nativeNumberIsSafeInteger(length) || length < 0 || length > allowed.length) return undefined
			const remaining = new NativeMap<T, number>()
			for (let index = 0; index < allowed.length; index += 1) {
				const item = allowed[index]!
				setNativeMap(remaining, item, (getNativeMap(remaining, item) ?? 0) + 1)
			}
			const snapshot: T[] = []
			for (let index = 0; index < length; index += 1) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(value, index)
				if (!descriptor || !('value' in descriptor)) return undefined
				const item = descriptor.value as T
				const count = getNativeMap(remaining, item) ?? 0
				if (count === 0) return undefined
				if (count === 1) deleteNativeMap(remaining, item)
				else setNativeMap(remaining, item, count - 1)
				pushNativeArray(snapshot, item)
			}
			return snapshot
		} catch { return undefined }
	}
	const snapshotIntegrationItems = (items: readonly T[]): readonly T[] => {
		const snapshot = sliceNativeArray(items, 0)
		return nativeReflectApply(nativeObjectFreeze, Object, [snapshot]) as readonly T[]
	}

	const isNonRetryableError = (error: unknown): boolean => {
		return readDataProperty(error, 'code') === 'BREAKER_OPEN' ||
			readDataProperty(error, 'nonRetryable') === true ||
			readDataProperty(error, 'retryable') === false
	}

	const isAmbiguousDeliveryError = (error: unknown): boolean =>
		readDataProperty(error, 'ambiguousDelivery') === true

	const isPendingAmbiguousDeliveryError = (error: unknown): boolean =>
		!!error && (typeof error === 'object' || typeof error === 'function')
			&& hasNativeWeakSet(trackedPendingAmbiguousErrors, error as object)
	const hasUnsafeRetryDecisionMetadata = (error: unknown): boolean => {
		if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false
		if (!hasSafePrototypeChain(error)) return true
		try {
			let current: object | null = error as object
			for (let depth = 0; current && current !== nativeObjectPrototype && depth < 32; depth += 1) {
				for (let index = 0; index < RETRY_DECISION_FIELDS.length; index += 1) {
					const descriptor = nativeObjectGetOwnPropertyDescriptor(current, RETRY_DECISION_FIELDS[index]!)
					if (!descriptor) continue
					if (current !== error || !('value' in descriptor)) return true
					containNativePromiseUnchecked(descriptor.value)
					const field = RETRY_DECISION_FIELDS[index]!
					if (field !== 'code' && descriptor.value !== undefined
						&& typeof descriptor.value !== 'boolean') return true
				}
				current = nativeObjectGetPrototypeOf(current) as object | null
			}
			return current !== null && current !== nativeObjectPrototype
		} catch { return true }
	}

	const waitForBackoff = async(delayMs: number): Promise<void> => {
		if (signal?.aborted() || delayMs <= 0) return
		await createNativePromise<void>((resolve) => {
			let settled = false
			let timer: ReturnType<typeof setTimeout> | undefined
			const finish = (): void => {
				if (settled) return
				settled = true
				clearTimerSafely(timer)
				try { signal?.remove(finish) } catch { /* Best-effort listener cleanup. */ }
				resolve()
			}
			try { timer = scheduleTimer(finish, delayMs) } catch {
				// Attempts are already bounded. If the host cannot allocate a backoff
				// timer, continue immediately rather than converting retryable work into
				// a permanent drop outside the retry loop.
				finish()
				return
			}
			// A non-conforming timer host may invoke the callback synchronously.
			// Do not install a listener after the wait has already completed.
			if (settled) {
				clearTimerSafely(timer)
				return
			}
			// An explicit flush/shutdown awaiting this retry must keep the process
			// alive until the bounded backoff completes. Only autonomous batch
			// scheduling timers are safe to unref.
			try { signal?.add(finish) } catch {
				// Cancellation listener registration is advisory. Continue the bounded
				// retry immediately rather than dropping its already-admitted items.
				finish()
				return
			}
			if (signal?.aborted()) finish()
		})
	}

	const getDeliveredPrefixCount = (
		error: unknown,
		attemptedCount: number
	): number => {
		const deliveredCount = readDataProperty(error, 'deliveredCount')
		// Rejected-send acknowledgement metadata is untrusted. Clamping or
		// truncating malformed values can turn an over-count into an assertion that
		// the whole batch was delivered and silently discard it. Only an exact,
		// in-range count is safe to use as a delivered prefix.
		if (!nativeNumberIsSafeInteger(deliveredCount) || (deliveredCount as number) < 0
			|| (deliveredCount as number) > attemptedCount) return 0
		return deliveredCount as number
	}
	const hasMalformedDeliveredPrefix = (error: unknown, attemptedCount: number): boolean => {
		if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false
		// A rejected physical send is retryable only when acknowledgement metadata
		// can be proven absent or is a valid own data property. If the rejection is
		// a Proxy, hides the field behind an accessor/prototype, or cannot be safely
		// inspected, retrying the full batch could duplicate an accepted prefix.
		if (!hasSafePrototypeChain(error)) return true
		try {
			let current: object | null = error as object
			for (let depth = 0; current && current !== nativeObjectPrototype && depth < 32; depth += 1) {
				const descriptor = nativeObjectGetOwnPropertyDescriptor(current, 'deliveredCount')
				if (descriptor) {
					if (current !== error || !('value' in descriptor)) return true
					containNativePromiseUnchecked(descriptor.value)
					return !nativeNumberIsSafeInteger(descriptor.value) || descriptor.value < 0
						|| descriptor.value > attemptedCount
				}
				current = nativeObjectGetPrototypeOf(current) as object | null
			}
			return current !== null && current !== nativeObjectPrototype
		} catch { return true }
	}

	const createAttemptTimeoutError = (
		items: readonly T[]
	): Error & {
		code: 'DELIVERY_TIMEOUT';
		nonRetryable: true;
		ambiguousDelivery: true;
		pendingAmbiguousDelivery: boolean;
		items: readonly T[];
	} =>
		nativeObjectAssign(
			new Error(`Operation timed out after ${retry.attemptTimeoutMs}ms`),
			{
				code: 'DELIVERY_TIMEOUT' as const,
				nonRetryable: true as const,
				ambiguousDelivery: true as const,
				pendingAmbiguousDelivery: false,
				items
			}
		)
	const invalidSendCompletion = (): Error & {
		nonRetryable: true;
		ambiguousDelivery: true;
	} => nativeObjectAssign(new TypeError('Batch retry send must return an adoptable native Promise'), {
		nonRetryable: true as const,
		ambiguousDelivery: true as const
	})
	const invalidSendAcknowledgement = (message: string, cause?: unknown): TypeError & {
		nonRetryable: true;
		ambiguousDelivery: true;
	} => nativeObjectAssign(new TypeError(message, cause === undefined ? undefined : {cause}), {
		nonRetryable: true as const,
		ambiguousDelivery: true as const
	})

	const resolveDeliveredCount = (
		result: void | BatchRetrySendResult,
		fallbackCount: number
	): number => {
		try {
			if (result === undefined) return fallbackCount
			if (!result || typeof result !== 'object' || nativeArrayIsArray(result) || isProxyObject(result)) {
				throw invalidSendAcknowledgement('Invalid batch retry send result')
			}
			const prototype = nativeObjectGetPrototypeOf(result)
			if (prototype !== nativeObjectPrototype && prototype !== null) {
				throw invalidSendAcknowledgement('Invalid batch retry send result')
			}
			const deliveredCountDescriptor = nativeObjectGetOwnPropertyDescriptor(result, 'deliveredCount')
			if (!deliveredCountDescriptor) return fallbackCount
			// An accessor-backed acknowledgement is present but untrustworthy. Treating
			// it as an absent optional field would assert that the complete physical
			// send succeeded and can silently discard an undelivered batch.
			if (!('value' in deliveredCountDescriptor)) {
				throw invalidSendAcknowledgement('Invalid batch retry deliveredCount')
			}
			const deliveredCount = deliveredCountDescriptor.value
			containNativePromiseUnchecked(deliveredCount)
			if (!nativeNumberIsSafeInteger(deliveredCount) || (deliveredCount as number) < 0 ||
				(deliveredCount as number) > fallbackCount) {
				throw invalidSendAcknowledgement('Invalid batch retry deliveredCount')
			}
			return deliveredCount as number
		} catch(error) {
			if (isAmbiguousDeliveryError(error)) throw error
			throw invalidSendAcknowledgement('Invalid batch retry send acknowledgement', error)
		}
	}
	const inspectAmbiguousResult = (
		result: unknown,
		attemptedItems: readonly T[]
	): unknown => {
		const deliveredCount = resolveDeliveredCount(
			result as void | BatchRetrySendResult,
			attemptedItems.length
		)
		if (deliveredCount > 0) successSafely(deliveredCount)
		if (deliveredCount === attemptedItems.length) return undefined
		return nativeObjectAssign(new Error('Late batch retry send partially delivered'), {
			code: 'DELIVERY_PARTIAL_LATE',
			nonRetryable: true,
			deliveredCount
		})
	}
	const {
		reportObserverError: _reportObserverError,
		trackSend,
		trackAmbiguousDelivery,
		canStartAmbiguousDelivery,
		waitForAmbiguousDeliveries,
		assertNoAmbiguousDeliveries,
		surfaceLateAmbiguousFailure
	} = createBatchRetryTracking<T>({
		telemetry,
		inspectAmbiguousResult,
		onAmbiguousFailure,
		invokeIntegration
	})

	const sendAttempt = async(
		items: readonly T[]
	): Promise<void | BatchRetrySendResult> => {
		// Integrations receive membership snapshots, never the array that owns
		// retry state. `readonly` is erased at runtime and cannot prevent an adapter
		// from truncating, sorting, or replacing elements in a caller-owned array.
		const attemptedItems = snapshotIntegrationItems(items)
		const parentAbortedBeforeStart = (): Error & {
			code: 'DELIVERY_ABORTED_BEFORE_START';
			nonRetryable: true;
			knownNoDelivery: true;
		} => nativeObjectAssign(new Error('Batch retry parent signal aborted before delivery started'), {
			code: 'DELIVERY_ABORTED_BEFORE_START' as const,
			nonRetryable: true as const,
			knownNoDelivery: true as const
		})
		const invokeSend = (): Promise<void | BatchRetrySendResult> => {
			// The integration call is the physical-delivery boundary. Parent aborts
			// may occur while the deadline handle is being allocated or detached,
			// after the listener-registration recheck below but before this deferred
			// callback runs. Recheck here so cancelled work remains known-not-started.
			if (signal?.aborted()) {
				abortFromParent()
				throw parentAbortedBeforeStart()
			}
			const result = invokeIntegration(() => sendWithSignal
				? sendWithSignal(attemptedItems, controller.signal)
				: send(attemptedItems))
			const completion = captureNativePromiseResult<void | BatchRetrySendResult>(result)
			if (!completion) throw invalidSendCompletion()
			return completion
		}
		if (!canStartAmbiguousDelivery()) {
			throw nativeObjectAssign(new Error('Batch retry physical delivery capacity exhausted'), {
				code: 'DELIVERY_CAPACITY',
				nonRetryable: true,
				knownNoDelivery: true
			})
		}
		if (
			!nativeNumberIsFinite(retry.attemptTimeoutMs) ||
			retry.attemptTimeoutMs <= 0
		) {
			const result = invokeIntegration(() => send(attemptedItems))
			const completion = captureNativePromiseResult<void | BatchRetrySendResult>(result)
			if (!completion) throw invalidSendCompletion()
			return await completion
		}

		const controller = createSafeAbortController()
		const abortFromParent = (): void => {
			try {
				controller.abort(signal?.reason())
			} catch {
				controller.abort()
			}
		}
		if (signal?.aborted()) {
			abortFromParent()
		} else {
			try { signal?.add(abortFromParent) } catch {
				// The attempt deadline still owns physical completion. A broken optional
				// parent-listener capability must not prevent delivery altogether.
			}
		}
		// AbortSignal does not replay an abort event to a listener registered
		// after the transition. Recheck after registration so a capability that
		// aborts during addEventListener cannot start physical work with a missed
		// parent cancellation and retain shutdown until the attempt deadline.
		if (signal?.aborted()) {
			abortFromParent()
			throw parentAbortedBeforeStart()
		}

		let timedOut = false
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined
		const timeoutError = createAttemptTimeoutError(attemptedItems)
		let rejectTimeout!: (error: unknown) => void
		const timeout = createNativePromise<never>((_, reject) => { rejectTimeout = reject })
		isolateUnexpectedThenable(timeout)
		let delivery: Promise<void | BatchRetrySendResult> | undefined

		try {
			try {
				timeoutTimer = trackDeliveryTimer(scheduleTimer(() => {
					if (timeoutTimer) deleteNativeSet(deliveryTimers, timeoutTimer)
					timedOut = true
					controller.abort(timeoutError)
					rejectTimeout(timeoutError)
				}, retry.attemptTimeoutMs))
			} catch {
				throw nativeObjectAssign(new Error('Batch retry deadline timer could not be scheduled'), {
					code: 'DELIVERY_TIMER_UNAVAILABLE',
					nonRetryable: true,
					knownNoDelivery: true
				})
			}
			if (timedOut) {
				throw nativeObjectAssign(new Error('Batch retry deadline elapsed before delivery started'), {
					code: 'DELIVERY_TIMEOUT_BEFORE_START', knownNoDelivery: true
				})
			}
			// Defer integration invocation into the owned promise. A synchronous throw
			// must still cross the cleanup finally below.
			delivery = deferNativePromise(invokeSend)
			isolateUnexpectedThenable(delivery)
			return await raceNativePromises([delivery, timeout])
		} catch(error) {
			// A non-conforming timer may execute the deadline callback before
			// setTimeout() returns. No physical operation exists in that state, so
			// routing it through ambiguity tracking would both lose the original
			// known-no-delivery error and attempt to observe an undefined promise.
			if (!timedOut || delivery === undefined) {
				throw error
			}
			let graceTimer: ReturnType<typeof setTimeout> | undefined
			type DeliveryOutcome =
				| {status: 'pending'}
				| {status: 'fulfilled'; value: void | BatchRetrySendResult}
				| {status: 'rejected'; error: unknown}
			let resolveGrace!: (value: DeliveryOutcome) => void
			const grace = createNativePromise<DeliveryOutcome>((resolve) => { resolveGrace = resolve })
			try {
				graceTimer = trackDeliveryTimer(scheduleTimer(() => {
					if (graceTimer) deleteNativeSet(deliveryTimers, graceTimer)
					resolveGrace({status: 'pending'})
				}, ATTEMPT_TIMEOUT_ABORT_GRACE_MS))
			} catch {
				nativeObjectAssign(timeoutError, {pendingAmbiguousDelivery: true})
				addNativeWeakSet(trackedPendingAmbiguousErrors, timeoutError)
				trackAmbiguousDelivery(delivery, attemptedItems)
				throw timeoutError
			}
			const deliveryOutcome = mapNativePromise<void | BatchRetrySendResult, DeliveryOutcome>(
				delivery,
				(value) => ({status: 'fulfilled', value}),
				(deliveryError) => ({status: 'rejected', error: deliveryError})
			)
			const settled = await raceNativePromises<DeliveryOutcome>([
				deliveryOutcome,
				grace
			])
			clearDeliveryTimer(graceTimer)
			if (settled.status === 'fulfilled') {
				return settled.value
			}
			if (settled.status === 'rejected') {
				// The deadline already elapsed before this rejection arrived. A sink
				// may translate the abort into a generic AbortError even after the
				// remote side accepted the payload, so retrying that value can duplicate
				// delivery. Preserve the authoritative ambiguous timeout outcome.
				throw timeoutError
			}
			nativeObjectAssign(timeoutError, {pendingAmbiguousDelivery: true})
			addNativeWeakSet(trackedPendingAmbiguousErrors, timeoutError)
			trackAmbiguousDelivery(delivery, attemptedItems)
			throw timeoutError
		} finally {
			clearDeliveryTimer(timeoutTimer)
			// Listener disposal is cleanup only. Once the physical send has succeeded,
			// a caller-owned removal failure must not manufacture a retry and duplicate
			// an already accepted batch.
			try { signal?.remove(abortFromParent) } catch { /* Best-effort cleanup. */ }
		}
	}

	const sendWithRetry = async(items: T[]): Promise<void> => {
		if (items.length === 0) return
		let pendingItems: readonly T[] = items
		const resolveRetryItems = (
			error: unknown,
			deliveredPrefixCount: number
		): readonly T[] | undefined => {
			const undeliveredItems = sliceNativeArray(pendingItems, deliveredPrefixCount)
			if (!getRetryItems) {
				return undeliveredItems
			}
			try {
				const attemptedItems = snapshotIntegrationItems(pendingItems)
				const retryItems = invokeSynchronousIntegration(
					() => getRetryItems(error, attemptedItems), 'Batch retry getRetryItems'
				)
				// A rejected send may authoritatively acknowledge a delivered prefix.
				// The projector still receives the complete attempted membership for
				// diagnosis, but it may only select from the known-undelivered suffix;
				// accepting prefix members here would duplicate an acknowledged delivery.
				const snapshot = snapshotSubset(retryItems, undeliveredItems)
				if (!snapshot) throw new Error('Invalid batch retry item projection')
				return snapshot
			} catch(projectionError) {
				const failure = nativeObjectAssign(new Error(
					'Invalid batch retry item projection', {cause: projectionError}
				), {
					code: 'DELIVERY_RETRY_PROJECTION_INVALID',
					nonRetryable: true,
					ambiguousDelivery: true,
					deliveryError: error
				})
				errorSafely(failure)
				// A projector may carry item-level knowledge about non-prefix successes.
				// If it fails, retrying the entire suffix can duplicate those successes,
				// while dropping it loses known-undelivered work. Preserve the ownership
				// ambiguity and require the integration's error path to handle it.
				return undefined
			}
		}
		const preparePendingItems = (): void => {
			if (!prepareItems) return
			try {
				const attemptedItems = snapshotIntegrationItems(pendingItems)
				const prepared = invokeSynchronousIntegration(
					() => prepareItems(attemptedItems), 'Batch retry prepareItems'
				)
				const preparedItems = readDataProperty(prepared, 'items')
				const snapshot = snapshotSubset(preparedItems, pendingItems)
				if (!snapshot) throw new Error('Invalid batch retry prepared items')
				const reasonValue = readDataProperty(prepared, 'dropReason')
				const reason = typeof reasonValue === 'string' && reasonValue.length <= 128
					? reasonValue : 'filtered'
				const droppedCount = pendingItems.length - snapshot.length
				if (droppedCount > 0) {
					markSafely('drop', {reason}, droppedCount)
					droppedSafely(droppedCount, reason)
				}
				pendingItems = snapshot
			} catch(preparationError) {
				errorSafely(preparationError)
				droppedSafely(pendingItems.length, 'invalid-prepare-items')
				pendingItems = []
			}
		}

		// Check for cancellation
		if (signal?.aborted()) {
			markSafely('drop', {reason: 'signal-aborted'})
			droppedSafely(items.length, 'signal-aborted')
			return
		}

		// If noRetry is true, send once without retries
		if (noRetry) {
			preparePendingItems()
			if (pendingItems.length === 0) return
			markSafely('write-batch', undefined, pendingItems.length)
			try {
				const result = await sendAttempt(pendingItems)
				const deliveredCount = resolveDeliveredCount(result, pendingItems.length)
				markSafely('flush', undefined, 0)
				if (deliveredCount > 0) successSafely(deliveredCount)
				const undeliveredCount = pendingItems.length - deliveredCount
				if (undeliveredCount > 0) {
					markSafely('drop', {reason: 'partial-delivery'}, undeliveredCount)
					droppedSafely(undeliveredCount, 'partial-delivery')
				}
				return
			} catch(error) {
				if (hasUnsafeRetryDecisionMetadata(error)) {
					const metadataError = invalidSendAcknowledgement(
						'Invalid rejected batch retry decision metadata', error
					)
					markSafely('error', {reason: 'invalid-retry-decision-metadata'})
					errorSafely(metadataError)
					return
				}
				if (hasMalformedDeliveredPrefix(error, pendingItems.length)) {
					const acknowledgementError = invalidSendAcknowledgement(
						'Invalid rejected batch retry deliveredCount', error
					)
					markSafely('error', {reason: 'invalid-delivery-acknowledgement'})
					errorSafely(acknowledgementError)
					return
				}
				const ambiguousDelivery = isAmbiguousDeliveryError(error)
				const nonRetryable = isNonRetryableError(error)
				const deliveredPrefixCount = getDeliveredPrefixCount(error, pendingItems.length)
				if (deliveredPrefixCount > 0) successSafely(deliveredPrefixCount)
				markSafely('error')
				if (ambiguousDelivery) {
					if (!isPendingAmbiguousDeliveryError(error)) {
						errorSafely(error)
					}
					return
				}
				const retryItems = resolveRetryItems(error, deliveredPrefixCount)
				if (!retryItems) return
				pendingItems = retryItems
				errorSafely(error)
				if (pendingItems.length > 0) {
					droppedSafely(pendingItems.length, nonRetryable ? 'non-retryable' : 'no-retry')
				}
				return
			}
		}

		// Retry logic
		const maxAttempts = nativeMathMax(1, retry.maxAttempts)
		let attempt = 0
		let lastErr: unknown

		try {
			while (attempt < maxAttempts && pendingItems.length > 0) {
				// Check for cancellation before each attempt
				if (signal?.aborted()) {
					markSafely('drop', {reason: 'signal-aborted'})
					droppedSafely(pendingItems.length, 'signal-aborted')
					return
				}

				attempt++
				preparePendingItems()
				if (pendingItems.length === 0) return
				markSafely('write-batch', undefined, pendingItems.length)

				try {
					const result = await sendAttempt(pendingItems)
					const deliveredCount = resolveDeliveredCount(result, pendingItems.length)
					if (deliveredCount > 0) successSafely(deliveredCount)
					if (deliveredCount === pendingItems.length) {
						markSafely('flush', undefined, 0)
						return
					}
					pendingItems = sliceNativeArray(pendingItems, deliveredCount)
					lastErr = nativeObjectAssign(new Error('Batch retry send partially delivered'), {
						deliveredCount
					})
					markSafely('error', {reason: 'partial-delivery'})
					if (attempt >= maxAttempts) break
					const delay = exponentialBackoff(attempt, {
						baseDelayMs: retry.baseDelayMs,
						multiplier: retry.multiplier,
						maxDelayMs: retry.maxDelayMs,
						jitter: retry.jitter
					})
					markSafely('retry', {attempt, delay})
					await waitForBackoff(delay)
				} catch(error) {
					lastErr = error
					if (hasUnsafeRetryDecisionMetadata(error)) {
						const metadataError = invalidSendAcknowledgement(
							'Invalid rejected batch retry decision metadata', error
						)
						markSafely('error', {reason: 'invalid-retry-decision-metadata'})
						errorSafely(metadataError)
						return
					}
					if (hasMalformedDeliveredPrefix(error, pendingItems.length)) {
						const acknowledgementError = invalidSendAcknowledgement(
							'Invalid rejected batch retry deliveredCount', error
						)
						markSafely('error', {reason: 'invalid-delivery-acknowledgement'})
						errorSafely(acknowledgementError)
						return
					}
					const ambiguousDelivery = isAmbiguousDeliveryError(error)
					const nonRetryable = isNonRetryableError(error)
					const deliveredPrefixCount = getDeliveredPrefixCount(
						error,
						pendingItems.length
					)
					if (deliveredPrefixCount > 0) {
						successSafely(deliveredPrefixCount)
					}
					markSafely('error')

					if (ambiguousDelivery) {
						if (!isPendingAmbiguousDeliveryError(error)) {
							errorSafely(error)
						}
						return
					}
					const retryItems = resolveRetryItems(error, deliveredPrefixCount)
					if (!retryItems) return
					pendingItems = retryItems

					if (nonRetryable) {
						errorSafely(error)
						droppedSafely(pendingItems.length, 'non-retryable')
						return
					}

					if (attempt >= maxAttempts) break

					// Check for cancellation before backoff
					if (signal?.aborted()) {
						markSafely('drop', {reason: 'signal-aborted'})
						droppedSafely(pendingItems.length, 'signal-aborted')
						return
					}

					// Backoff
					const delay = exponentialBackoff(attempt, {
						baseDelayMs: retry.baseDelayMs,
						multiplier: retry.multiplier,
						maxDelayMs: retry.maxDelayMs,
						jitter: retry.jitter
					})
					markSafely('retry', {attempt, delay})

					await waitForBackoff(delay)
				}
			}

			// Exhausted retries
			errorSafely(lastErr)
			droppedSafely(pendingItems.length, 'retry-exhausted')
		} catch(error) {
			errorSafely(error)
			droppedSafely(pendingItems.length, 'error')
		}
	}

	const flush = async(admissionBarrier = admissionId): Promise<void> => {
		if (flushTimer) {
			clearTimerSafely(flushTimer)
			flushTimer = undefined
		}
		const activeAtRequest = activeFlush
		const activeAtRequestFirstId = activeFlushFirstAdmissionId
		if (activeAtRequest) {
			if (activeAtRequestFirstId > admissionBarrier) return
			await activeAtRequest
		}
		// Several callers may resume from the same completed send. The first one
		// can synchronously claim the rollover batch before the others continue.
		// That newly claimed generation was already pending when those callers
		// requested their barrier, so they must join it as well.
		while (activeFlush && activeFlush !== activeAtRequest &&
			activeFlushFirstAdmissionId <= admissionBarrier) {
			await activeFlush
		}
		if (batch.length === 0 || batchFirstAdmissionId > admissionBarrier) return

		const firstAdmissionId = batchFirstAdmissionId
		const operation = (async() => {
			// Claim exactly one bounded generation. Traffic admitted while its send
			// is pending belongs to a later flush; chasing it here could make this
			// public barrier starve forever under continuous writes.
			const toSend = spliceNativeArray(batch, 0)
			batchBytes = 0
			batchFirstAdmissionId = 0
			const sendPromise = trackSend((async() => {
				await undefined
				try {
					await sendWithRetry(toSend)
				} catch(error) {
					markSafely('error', {reason: 'send_failed'})
					errorSafely(error)
				}
			})())
			await sendPromise
		})()
		activeFlush = operation
		activeFlushFirstAdmissionId = firstAdmissionId
		try {
			await operation
		} finally {
			if (activeFlush === operation) {
				activeFlush = undefined
				activeFlushFirstAdmissionId = 0
			}
		}
	}

	const write = (item: T): void => {
		if (isIntegrationInvocation()) return
		if (closed || closing) {
			droppedSafely(1, 'closed')
			return
		}
		// Check if item fits in current batch
		let itemBytes: number
		try {
			itemBytes = invokeSynchronousIntegration(
				() => getItemSize(item), 'Batch retry getItemSize'
			)
		} catch(error) {
			errorSafely(error)
			droppedSafely(1, 'invalid-item-size')
			return
		}
		if (!nativeNumberIsSafeInteger(itemBytes) || itemBytes < 0) {
			errorSafely(new Error('Invalid batch retry item size'))
			droppedSafely(1, 'invalid-item-size')
			return
		}
		if (itemBytes > batching.maxBytes) {
			markSafely('drop', {reason: 'item-too-large'}, 1)
			droppedSafely(1, 'item-too-large')
			return
		}
		const fitsItems = batch.length + 1 <= batching.maxBatch
		const fitsBytes = batchBytes + itemBytes <= batching.maxBytes

		if (fitsItems && fitsBytes) {
			// Add to batch
			const id = ++admissionId
			if (batch.length === 0) batchFirstAdmissionId = id
			pushNativeArray(batch, item)
			batchBytes += itemBytes

			if (
				batch.length >= batching.maxBatch ||
				batchBytes >= batching.maxBytes
			) {
				void flush()
			} else {
				planFlush()
			}
		} else {
			if (batch.length !== 0) {
				// One active send may own one bounded rollover batch. A third
				// generation has no backpressure contract, so drop instead of retaining
				// an unbounded continuation per caller.
				if (activeFlush) {
					markSafely('drop', {reason: 'batch-capacity'}, 1)
					droppedSafely(1, 'batch-capacity')
					return
				}
				// flush() publishes ownership synchronously before its first await, so
				// the recursive write can enter the one bounded rollover batch without
				// allocating an unbounded continuation per caller.
				void flush()
				write(item)
			}
		}
	}

	const forceFlushInternal = async(): Promise<void> => {
		const admissionBarrier = admissionId
		if (flushTimer) {
			clearTimerSafely(flushTimer)
			flushTimer = undefined
		}

		// Drain only work admitted when this barrier was requested. Later traffic
		// remains owned by its autonomous flush and cannot starve this caller.
		while ((batch.length > 0 && batchFirstAdmissionId <= admissionBarrier) ||
			(activeFlush !== undefined && activeFlushFirstAdmissionId <= admissionBarrier)) {
			await flush(admissionBarrier)
		}
		// A timed-out sink may ignore AbortSignal forever. The attempt already paid
		// the bounded abort grace period before entering ambiguity tracking. Reject
		// the public barrier while leaving that physical operation tracked; close()
		// therefore cannot mark the pipeline closed, and no retry can duplicate it.
		assertNoAmbiguousDeliveries()
		surfaceLateAmbiguousFailure()
	}

	const forceFlush = async(): Promise<void> => {
		if (isIntegrationInvocation()) return
		if (closePromise) return await closePromise
		if (closed) return
		await runExplicitBarrier(forceFlushInternal)
	}

	const close = (): Promise<void> => {
		if (isIntegrationInvocation() || closed) return createNativePromise((resolve) => { resolve() })
		if (closePromise) return closePromise
		closing = true
		const operation = (async() => {
			await runExplicitBarrier(forceFlushInternal)
			closed = true
			closing = false
		})()
		closePromise = operation
		isolateUnexpectedThenable(operation, () => {
			if (closePromise === operation) closePromise = undefined
			closing = false
		})
		return operation
	}

	return {
		write,
		flush: forceFlush,
		waitForAmbiguousDeliveries,
		close,
		getBatchSize: () => batch.length,
		getBatchBytes: () => batchBytes
	}
}
