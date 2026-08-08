import {
	captureNativePromiseResult,
	containNativePromiseUnchecked,
	createNativePromise,
	isolateUnexpectedThenable,
	observeNativePromiseSettlement
} from '../async/native-promise'
import {
	addNativeSet,
	deleteNativeSet,
	pushNativeArray,
	sizeNativeSet,
	sliceNativeArray,
	snapshotNativeSet
} from '../collections/native-collections'

const NativeSet = Set

import type {TelemetryHooks} from './batch-retry-types'

const MAX_ACTIVE_AMBIGUOUS_DELIVERIES = 100
const MAX_RETAINED_LATE_AMBIGUOUS_FAILURES = MAX_ACTIVE_AMBIGUOUS_DELIVERIES
const nativeNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER
const MAX_OMITTED_LATE_AMBIGUOUS_FAILURES = nativeNumberMaxSafeInteger
	- MAX_RETAINED_LATE_AMBIGUOUS_FAILURES
const nativeObjectAssign = Object.assign
const nativeObjectFreeze = Object.freeze

export interface BatchRetryTracking<T> {
	reportObserverError(error: unknown, info?: Record<string, unknown>): void;
	trackSend(sendPromise: Promise<void>): Promise<void>;
	trackContinuation(continuation: Promise<void>): void;
	trackAmbiguousDelivery(
		delivery: Promise<unknown>,
		attemptedItems: readonly T[],
	): void;
	canStartAmbiguousDelivery(): boolean;
	waitForActiveSends(): Promise<void>;
	waitForContinuations(): Promise<void>;
	waitForAmbiguousDeliveries(): Promise<void>;
	assertNoAmbiguousDeliveries(): void;
	surfaceLateAmbiguousFailure(): void;
	hasActiveWork(): boolean;
}

export function createBatchRetryTracking<T>(options: {
	telemetry?: TelemetryHooks | undefined;
	invokeIntegration?: (<TResult>(callback: () => TResult) => TResult) | undefined;
	inspectAmbiguousResult?:
			| ((result: unknown, attemptedItems: readonly T[]) => unknown)
			| undefined;
	onAmbiguousFailure?:
			| ((
				error: unknown,
				attemptedItems: readonly T[]
			) => Promise<boolean | void> | boolean | void)
		| undefined;
}): BatchRetryTracking<T> {
	const {
		telemetry,
		inspectAmbiguousResult,
		onAmbiguousFailure,
		invokeIntegration = (callback) => callback()
	} = options
	const activeSends = new NativeSet<Promise<void>>()
	const activeContinuations = new NativeSet<Promise<void>>()
	const activeAmbiguousDeliveries = new NativeSet<Promise<void>>()
	let lateAmbiguousFailures: unknown[] = []
	let omittedLateAmbiguousFailureCount = 0
	const reportObserverError = (
		error: unknown,
		info?: Record<string, unknown>
	): void => {
		try {
			isolateUnexpectedThenable(invokeIntegration(
				() => telemetry?.onMark?.('error', info ?? {reason: 'observer_failure'})
			))
		} catch(error) {
			containNativePromiseUnchecked(error)
			// Telemetry observer failures must not alter delivery decisions.
		}
		try {
			isolateUnexpectedThenable(invokeIntegration(() => telemetry?.onError?.(error)))
		} catch(error) {
			containNativePromiseUnchecked(error)
			// Telemetry observer failures must not create unhandled rejections.
		}
	}

	const trackSend = (sendPromise: Promise<void>): Promise<void> => {
		addNativeSet(activeSends, sendPromise)
		const cleanup = (async() => {
			try { await sendPromise } catch { /* sendWithRetry owns the failure. */ }
			finally { deleteNativeSet(activeSends, sendPromise) }
		})()
		isolateUnexpectedThenable(cleanup)
		return sendPromise
	}

	const trackContinuation = (continuation: Promise<void>): void => {
		addNativeSet(activeContinuations, continuation)
		const cleanup = (async() => {
			try { await continuation } catch(error) { reportObserverError(error) }
			finally { deleteNativeSet(activeContinuations, continuation) }
		})()
		isolateUnexpectedThenable(cleanup)
	}

	const markLateAmbiguousFailure = (error: unknown): void => {
		if (lateAmbiguousFailures.length < MAX_RETAINED_LATE_AMBIGUOUS_FAILURES) {
			pushNativeArray(lateAmbiguousFailures, error)
			return
		}
		if (omittedLateAmbiguousFailureCount < MAX_OMITTED_LATE_AMBIGUOUS_FAILURES) {
			omittedLateAmbiguousFailureCount += 1
		}
	}

	const surfaceLateAmbiguousFailure = (): void => {
		if (lateAmbiguousFailures.length === 0) return
		const failures = sliceNativeArray(lateAmbiguousFailures, 0)
		const omittedCount = omittedLateAmbiguousFailureCount
		lateAmbiguousFailures = []
		omittedLateAmbiguousFailureCount = 0
		if (failures.length === 1 && omittedCount === 0) throw failures[0]
		throw nativeObjectAssign(new Error('Multiple late ambiguous delivery failures'), {
			code: 'DELIVERY_AMBIGUOUS_LATE_FAILURES',
			nonRetryable: true,
			failureCount: failures.length + omittedCount,
			omittedFailureCount: omittedCount,
			failures: nativeObjectFreeze(failures)
		})
	}

	const trackAmbiguousDelivery = (
		delivery: Promise<unknown>,
		attemptedItems: readonly T[]
	): void => {
		let resolveTracked!: () => void
		const tracked = createNativePromise<void>((resolve) => { resolveTracked = resolve })
		addNativeSet(activeAmbiguousDeliveries, tracked)
		let finished = false
		const finish = (): void => {
			if (finished) return
			finished = true
			deleteNativeSet(activeAmbiguousDeliveries, tracked)
			resolveTracked()
		}
		const failHandler = (handlerError: unknown): void => {
			reportObserverError(handlerError, {
				reason: 'ambiguous_failure_handler_failed', late: true
			})
			markLateAmbiguousFailure(handlerError)
			finish()
		}
		const handleDeliveryError = (deliveryError: unknown): void => {
			try {
				isolateUnexpectedThenable(invokeIntegration(() => telemetry?.onMark?.('error', {
					reason: 'late_delivery_failure',
					late: true
				})))
			} catch(error) {
				containNativePromiseUnchecked(error)
				// Telemetry observer failures must not alter delivery decisions.
			}
			if (!onAmbiguousFailure) {
				reportObserverError(deliveryError, {
					reason: 'late_delivery_failure', late: true
				})
				markLateAmbiguousFailure(deliveryError)
				finish()
				return
			}
			const failAmbiguousFailureHandler = (handlerError: unknown): void => {
				reportObserverError(handlerError, {
					reason: 'ambiguous_failure_handler_failed', late: true
				})
				// A broken durability handler must not replace the physical failure it
				// failed to handle. Retain both causes so the next ownership barrier can
				// surface the original delivery outcome as well as the handler defect.
				markLateAmbiguousFailure(deliveryError)
				if (handlerError !== deliveryError) markLateAmbiguousFailure(handlerError)
				finish()
			}
			try {
				const result = invokeIntegration(() => onAmbiguousFailure(
					deliveryError, attemptedItems
				))
				const complete = (handled: boolean | void): void => {
					if (handled !== true) markLateAmbiguousFailure(deliveryError)
					finish()
				}
				const completion = captureNativePromiseResult<boolean | void>(result)
				if (completion) {
					if (!observeNativePromiseSettlement<boolean | void>(
						completion, complete, failAmbiguousFailureHandler
					)) failAmbiguousFailureHandler(new TypeError('Ambiguous failure handler completion is unsafe'))
					return
				}
				if (result !== undefined && typeof result !== 'boolean') {
					throw new TypeError('Ambiguous failure handler must return boolean, void, or a native Promise')
				}
				complete(result)
			} catch(handlerError) { failAmbiguousFailureHandler(handlerError) }
		}
		const handleDeliveryResult = (result: unknown): void => {
			if (!inspectAmbiguousResult) {
				finish()
				return
			}
			try {
				const failure = inspectAmbiguousResult(result, attemptedItems)
				if (failure === undefined) finish()
				else handleDeliveryError(failure)
			} catch(error) { handleDeliveryError(error) }
		}
		if (!observeNativePromiseSettlement(
			delivery,
			handleDeliveryResult,
			handleDeliveryError
		)) {
			failHandler(new TypeError('Ambiguous delivery must be an adoptable native Promise'))
		}
	}

	const waitForActiveSends = async(): Promise<void> => {
		while (sizeNativeSet(activeSends) > 0) {
			const operations = snapshotNativeSet(activeSends)
			for (let index = 0; index < operations.length; index += 1) {
				const operation = operations[index]!
				try { await operation } catch { /* The send owner handles its failure. */ }
			}
		}
	}

	const waitForContinuations = async(): Promise<void> => {
		while (sizeNativeSet(activeContinuations) > 0) {
			const operations = snapshotNativeSet(activeContinuations)
			for (let index = 0; index < operations.length; index += 1) {
				const operation = operations[index]!
				try { await operation } catch { /* Cleanup reports continuation failures. */ }
			}
		}
	}

	const waitForAmbiguousDeliveries = async(): Promise<void> => {
		while (sizeNativeSet(activeAmbiguousDeliveries) > 0) {
			const operations = snapshotNativeSet(activeAmbiguousDeliveries)
			for (let index = 0; index < operations.length; index += 1) {
				const operation = operations[index]!
				try { await operation } catch { /* Cleanup records the handler failure. */ }
			}
		}
	}

	const assertNoAmbiguousDeliveries = (): void => {
		if (sizeNativeSet(activeAmbiguousDeliveries) === 0) {
			return
		}
		const error = new Error(
			`batch delivery still pending after timeout (${sizeNativeSet(activeAmbiguousDeliveries)} attempt${sizeNativeSet(activeAmbiguousDeliveries) === 1 ? '' : 's'})`
		);
		(
			error as Error & {
				code?: string;
				nonRetryable?: boolean;
				ambiguousDelivery?: boolean;
			}
		).code = 'DELIVERY_AMBIGUOUS_PENDING';
		(
			error as Error & {
				code?: string;
				nonRetryable?: boolean;
				ambiguousDelivery?: boolean;
			}
		).nonRetryable = true;
		(
			error as Error & {
				code?: string;
				nonRetryable?: boolean;
				ambiguousDelivery?: boolean;
			}
		).ambiguousDelivery = true
		throw error
	}
	return {
		reportObserverError,
		trackSend,
		trackContinuation,
		trackAmbiguousDelivery,
		canStartAmbiguousDelivery: () => sizeNativeSet(activeAmbiguousDeliveries) < MAX_ACTIVE_AMBIGUOUS_DELIVERIES,
		waitForActiveSends,
		waitForContinuations,
		waitForAmbiguousDeliveries,
		assertNoAmbiguousDeliveries,
		surfaceLateAmbiguousFailure,
		hasActiveWork: () => sizeNativeSet(activeContinuations) > 0 || sizeNativeSet(activeSends) > 0
	}
}
