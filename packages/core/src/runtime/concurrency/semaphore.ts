/**
 * Simple async semaphore.
 */
import {containNativePromiseUnchecked, createNativePromise} from '../async/native-promise'
import {deleteNativeArrayPrefix, pushNativeArray} from '../collections/native-collections'

export interface Semaphore {
	acquire(): Promise<() => void>
}

const MAX_SEMAPHORE_PERMITS = 1_000_000
const MAX_SEMAPHORE_WAITERS = 4_096
const nativeMathFloor = Math.floor
const nativeMathMax = Math.max
const nativeNumberIsFinite = Number.isFinite

export function createSemaphore(max: number): Semaphore {
	containNativePromiseUnchecked(max)
	if (!nativeNumberIsFinite(max) || max > MAX_SEMAPHORE_PERMITS) {
		throw new RangeError(`Semaphore max must be finite and no greater than ${MAX_SEMAPHORE_PERMITS}`)
	}
	let avail = nativeMathMax(1, nativeMathFloor(max))
	const queue: Array<((release: () => void) => void) | undefined> = []
	let queueHead = 0

	function dequeue(): ((release: () => void) => void) | undefined {
		const next = queue[queueHead]
		if (!next) return undefined
		queue[queueHead] = undefined
		queueHead += 1
		if (queueHead === queue.length) {
			queue.length = 0
			queueHead = 0
		} else if (queueHead >= MAX_SEMAPHORE_WAITERS && queueHead * 2 >= queue.length) {
			// A permanently saturated queue never reaches the empty reset above.
			// Compact consumed tombstones before the backing array can grow without
			// bound while the live waiter count remains correctly capped.
			deleteNativeArrayPrefix(queue, queueHead)
			queueHead = 0
		}
		return next
	}

	function makeRelease(): () => void {
		let released = false
		return () => {
			if (released) return
			released = true
			const next = dequeue()
			if (next) next(makeRelease())
			else avail += 1
		}
	}

	return {
		acquire(): Promise<() => void> {
			if (avail > 0) {
				avail -= 1
				return createNativePromise((resolve) => { resolve(makeRelease()) })
			}
			if (queue.length - queueHead >= MAX_SEMAPHORE_WAITERS) {
				return createNativePromise((_resolve, reject) => {
					reject(new RangeError(`Semaphore waiter limit of ${MAX_SEMAPHORE_WAITERS} exceeded`))
				})
			}
			return createNativePromise((resolve) => { pushNativeArray(queue, resolve) })
		}
	}
}
