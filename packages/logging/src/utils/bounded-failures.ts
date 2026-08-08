const MAX_RETAINED_FAILURES = 100

export interface BoundedFailureBuffer<T> {
	push(failure: T): void
	drain(): Array<T | Error>
}

/**
 * Retain a representative, bounded set of asynchronous failures until the next
 * lifecycle boundary. The overflow marker keeps loss observable without
 * retaining an unbounded number of caller-owned error objects.
 */
export function createBoundedFailureBuffer<T>(
	label: string,
	maximum = MAX_RETAINED_FAILURES
): BoundedFailureBuffer<T> {
	if (!Number.isSafeInteger(maximum) || maximum < 1) {
		throw new TypeError('Logging failure buffer maximum must be a positive safe integer')
	}
	const retained: T[] = []
	let omitted = 0
	return {
		push(failure): void {
			if (retained.length < maximum) retained.push(failure)
			else omitted += 1
		},
		drain(): Array<T | Error> {
			const failures: Array<T | Error> = retained.splice(0)
			if (omitted > 0) {
				failures.push(new Error(`${label}: ${omitted} additional failures omitted`))
				omitted = 0
			}
			return failures
		}
	}
}
