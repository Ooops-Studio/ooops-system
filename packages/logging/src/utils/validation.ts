import {MAX_LOGGING_TIMER_MS} from '../constants'

export const assertPositiveTimerMs = (value: number, name: string): void => {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LOGGING_TIMER_MS) {
		throw new TypeError(`${name} must be a positive integer no greater than ${MAX_LOGGING_TIMER_MS}`)
	}
}

export const assertNonNegativeTimerMs = (value: number, name: string): void => {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LOGGING_TIMER_MS) {
		throw new TypeError(`${name} must be a non-negative integer no greater than ${MAX_LOGGING_TIMER_MS}`)
	}
}
