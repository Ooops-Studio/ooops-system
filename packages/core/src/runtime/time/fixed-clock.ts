/** Fixed clock for deterministic tests and simulations. */
import type {Clock} from '../../contracts/clock'
import {containNativePromiseUnchecked} from '../async/native-promise'

const nativeMathAbs = Math.abs
const nativeNumberIsFinite = Number.isFinite
const nativeNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER

export interface FixedClock extends Clock {
	set(nowMs: number): void
	advanceBy(deltaMs: number): void
}

function requireFiniteTimestamp(value: number, label: string): void {
	containNativePromiseUnchecked(value)
	if (!nativeNumberIsFinite(value) || nativeMathAbs(value) > nativeNumberMaxSafeInteger) {
		throw new RangeError(`${label} must be finite and within the safe numeric timestamp range`)
	}
}

export function createFixedClock(atMs: number): FixedClock {
	requireFiniteTimestamp(atMs, 'Fixed clock initial time')
	let now = atMs
	return {
		now: () => now,
		set(next: number) {
			requireFiniteTimestamp(next, 'Fixed clock time')
			now = next
		},
		advanceBy(delta: number) {
			requireFiniteTimestamp(delta, 'Fixed clock delta')
			const next = now + delta
			requireFiniteTimestamp(next, 'Fixed clock advanced time')
			now = next
		}
	}
}
