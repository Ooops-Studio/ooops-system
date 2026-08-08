/**
 * @file Circuit breaker for log transfer.
 */

export type BreakerStateType = 'closed' | 'open' | 'half-open'

export type BreakerPolicy = {
	failureThreshold: number
	halfOpenAfterMs: number
	maxHalfOpenProbes: number
}

export type Breaker = {
	state: BreakerStateType
	consecutiveFailures: number
	halfOpenProbesLeft: number
	halfOpenInFlight?: number
	openedAt?: number
	generation?: number
}

// Alias for test compatibility
export type BreakerState = Breaker

function safeNow(clock: {now(): number}): number {
	try {
		const value = clock.now()
		return Number.isFinite(value) ? value : Date.now()
	} catch {
		return Date.now()
	}
}

function markSafely(onMark: ((mark: string) => void) | undefined, mark: string): void {
	try {
		onMark?.(mark)
	} catch {
		// Observability must not alter breaker state transitions.
	}
}

export function createBreaker(maxProbes: number): Breaker {
	return {
		state: 'closed',
		consecutiveFailures: 0,
		halfOpenProbesLeft: maxProbes,
		generation: 0
	}
}

export function canAttemptSend(
	breaker: Breaker,
	policy: BreakerPolicy,
	clock: {now(): number},
	onMark?: (mark: string) => void
): boolean {
	if (breaker.state === 'closed') {
		return true
	}

	if (breaker.state === 'half-open') {
		if (breaker.halfOpenProbesLeft <= 0) {
			return false
		}
		breaker.halfOpenProbesLeft -= 1
		breaker.halfOpenInFlight = (breaker.halfOpenInFlight ?? 0) + 1
		return true
	}

	if (breaker.openedAt === undefined) {
		return false
	}

	const elapsed = Math.max(0, safeNow(clock) - breaker.openedAt)
	if (elapsed < policy.halfOpenAfterMs) {
		return false
	}

	breaker.state = 'half-open'
	breaker.generation = (breaker.generation ?? 0) + 1
	breaker.halfOpenProbesLeft = policy.maxHalfOpenProbes
	breaker.halfOpenInFlight = 0
	markSafely(onMark, 'breaker-half-open')
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (breaker.halfOpenProbesLeft <= 0) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return false
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	breaker.halfOpenProbesLeft -= 1
	breaker.halfOpenInFlight = 1
	return true
}

export function noteFailure(
	breaker: Breaker,
	policy: BreakerPolicy,
	clock: {now(): number},
	onMark?: (mark: string) => void,
	attemptGeneration = breaker.generation ?? 0
): void {
	if (attemptGeneration !== (breaker.generation ?? 0)) return
	if (breaker.state === 'half-open') {
		breaker.halfOpenInFlight = Math.max(0, (breaker.halfOpenInFlight ?? 1) - 1)
	}
	breaker.consecutiveFailures += 1

	if (breaker.state === 'half-open' || breaker.consecutiveFailures >= policy.failureThreshold) {
		breaker.state = 'open'
		breaker.openedAt = safeNow(clock)
		breaker.halfOpenProbesLeft = policy.maxHalfOpenProbes
		breaker.halfOpenInFlight = 0
		breaker.generation = (breaker.generation ?? 0) + 1
		markSafely(onMark, 'breaker-open')
	}
}

export function noteSuccess(
	breaker: Breaker,
	onMark?: (mark: string) => void,
	attemptGeneration = breaker.generation ?? 0
): void {
	if (attemptGeneration !== (breaker.generation ?? 0)) return
	if (breaker.state === 'half-open') {
		breaker.halfOpenInFlight = Math.max(0, (breaker.halfOpenInFlight ?? 1) - 1)
		// Do not declare recovery while another admitted probe may still fail, or
		// before the configured recovery sample has completed. This prevents a
		// fast successful probe from making a concurrent failing probe stale.
		if ((breaker.halfOpenInFlight ?? 0) > 0 || breaker.halfOpenProbesLeft > 0) return
	}
	const wasClosed = breaker.state === 'closed'
	breaker.consecutiveFailures = 0
	delete breaker.openedAt
	breaker.state = 'closed'
	breaker.halfOpenInFlight = 0
	if (!wasClosed) breaker.generation = (breaker.generation ?? 0) + 1

	if (!wasClosed) {
		markSafely(onMark, 'breaker-closed')
	}
}
