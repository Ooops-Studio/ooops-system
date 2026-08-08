import {createBoundedFailureBuffer} from '../../utils/bounded-failures'

export interface DeliveryState {
	track(promise: Promise<void>): Promise<void>
	trackAmbiguous(delivery: Promise<void>, error: unknown): void
	collect(errors: unknown[]): Promise<void>
	get hasAmbiguous(): boolean
}

export function createDeliveryState(): DeliveryState {
	const inFlight = new Set<Promise<void>>()
	const ambiguous = new Set<Promise<void>>()
	const trackedAmbiguousErrors = new WeakSet<object>()
	const directFailures = createBoundedFailureBuffer<unknown>('Logging delivery')
	const isTrackedAmbiguous = (error: unknown): boolean =>
		!!error && (typeof error === 'object' || typeof error === 'function')
			&& trackedAmbiguousErrors.has(error as object)

	const track = (promise: Promise<void>): Promise<void> => {
		const tracked = promise.catch((error: unknown) => {
			if (!isTrackedAmbiguous(error)) directFailures.push(error)
		}).finally(() => { inFlight.delete(tracked) })
		inFlight.add(tracked)
		return tracked
	}

	const trackAmbiguous = (delivery: Promise<void>, error: unknown): void => {
		if (error && (typeof error === 'object' || typeof error === 'function')) {
			trackedAmbiguousErrors.add(error as object)
		}
		const tracked = delivery.catch((lateError: unknown) => {
			directFailures.push(lateError)
			throw lateError
		}).finally(() => {
			ambiguous.delete(tracked)
		})
		ambiguous.add(tracked)
		void tracked.catch(() => undefined)
	}

	const collect = async(errors: unknown[]): Promise<void> => {
		await Promise.allSettled([...inFlight])
		// A timed-out caller may have handed off an abort-ignoring physical write.
		// Flush and close are ownership boundaries, so they must not complete while
		// that write can still reach the sink. Once it settles, trackAmbiguous either
		// records its terminal failure or clears the ambiguity after real success.
		await Promise.allSettled([...ambiguous])
		for (const failure of directFailures.drain()) {
			if (!errors.includes(failure)) errors.push(failure)
		}
	}

	return {track, trackAmbiguous, collect, get hasAmbiguous() { return ambiguous.size > 0 }}
}
