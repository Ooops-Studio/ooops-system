import type {Clock} from '@ooopsstudio/core/contracts/clock'

function captureClockNow(clock: unknown): ((...args: never[]) => unknown) | undefined {
	if (!clock || (typeof clock !== 'object' && typeof clock !== 'function')) return undefined
	let cursor: object | null = clock as object
	const visited = new Set<object>()
	try {
		while (cursor && !visited.has(cursor) && visited.size < 32) {
			visited.add(cursor)
			const descriptor = Object.getOwnPropertyDescriptor(cursor, 'now')
			if (descriptor) {
				return 'value' in descriptor && typeof descriptor.value === 'function'
					? descriptor.value as (...args: never[]) => unknown
					: undefined
			}
			cursor = Object.getPrototypeOf(cursor)
		}
	} catch {
		return undefined
	}
	return undefined
}

export function assertMetricsClock(clock: Clock | undefined, label = 'Metrics clock'): asserts clock is Clock {
	if (!captureClockNow(clock)) throw new Error(`${label} must provide now()`)
}

/** Capture a clock capability once without invoking accessors or trusting later mutation. */
export function snapshotMetricsClock(clock: Clock | undefined, label = 'Metrics clock'): Clock {
	const now = captureClockNow(clock)
	if (!now || !clock) throw new Error(`${label} must provide now()`)
	return Object.freeze({
		now: () => Reflect.apply(now, clock, []) as number
	})
}

export function validateMetricsTimestamp(timestamp: number, label = 'Metrics clock'): number {
	if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > Number.MAX_SAFE_INTEGER) {
		throw new Error(`${label} must return a finite non-negative safe timestamp`)
	}
	return timestamp
}

export function readMetricsClock(clock: Clock, label = 'Metrics clock'): number {
	const now = captureClockNow(clock)
	if (!now) throw new Error(`${label} must provide now()`)
	return validateMetricsTimestamp(Reflect.apply(now, clock, []) as number, label)
}
