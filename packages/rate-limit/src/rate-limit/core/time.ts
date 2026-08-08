import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {isRateLimitProxy} from '../utils/safe-object'

/** Capture a validated clock capability once so caller mutation cannot replace it later. */
export function snapshotRateLimitClock(clock: Clock, operation = 'handler'): Clock {
	if (!clock || isRateLimitProxy(clock)) throw new Error(`Rate-limit ${operation} requires a clock with now()`)
	let current: object | null = clock
	let now: Clock['now'] | undefined
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			if (isRateLimitProxy(current)) break
			const descriptor = Object.getOwnPropertyDescriptor(current, 'now')
			if (descriptor) {
				if ('value' in descriptor && typeof descriptor.value === 'function') now = descriptor.value as Clock['now']
				break
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { /* rejected below */ }
	if (!now) {
		throw new Error(`Rate-limit ${operation} requires a clock with now()`)
	}
	return Object.freeze({now: () => Reflect.apply(now!, clock, []) as number})
}

/** Read an epoch-millisecond clock without allowing invalid timestamps into quota state. */
export function readRateLimitClock(clock: Clock, operation: string): number {
	if (!clock || typeof clock.now !== 'function') {
		throw new Error(`Rate-limit ${operation} requires a clock with now()`)
	}
	const now = clock.now()
	if (!Number.isSafeInteger(now) || now < 0) {
		throw new Error(`Rate-limit ${operation} clock must return a non-negative safe-integer epoch timestamp`)
	}
	return now
}

/** Add a duration while preserving an exactly representable public reset timestamp. */
export function safeRateLimitDeadline(now: number, delayMs: number, operation: string): number {
	if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(delayMs) || delayMs < 0) {
		throw new Error(`Rate-limit ${operation} requires non-negative safe-integer time values`)
	}
	const deadline = now + delayMs
	if (!Number.isSafeInteger(deadline)) {
		throw new Error(`Rate-limit ${operation} deadline exceeds safe timestamp precision`)
	}
	return deadline
}
