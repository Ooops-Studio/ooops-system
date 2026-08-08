import {MAX_ACTIVE_REMOTE_REQUESTS} from '../../constants'

export interface RequestOwnership {
	readonly active: Set<Promise<unknown>>
	readonly maximum: number
	accepting: boolean
}

export function createRequestOwnership(maximum = MAX_ACTIVE_REMOTE_REQUESTS): RequestOwnership {
	return {active: new Set(), maximum, accepting: true}
}

export function hasRequestCapacity(ownership: RequestOwnership): boolean {
	return ownership.accepting && ownership.active.size < ownership.maximum
}

export async function waitForOwnedRequests(ownership: RequestOwnership): Promise<void> {
	await Promise.allSettled([...ownership.active])
}

/**
 * Reserve capacity before invoking fetch so synchronous re-entry cannot bypass
 * the physical-operation bound. Ownership ends only when the real request does.
 */
export function startOwnedRequest<T>(
	ownership: RequestOwnership,
	request: () => T | PromiseLike<T>
): Promise<T> {
	let start!: () => void
	const gate = new Promise<void>((resolve) => { start = resolve })
	let tracked!: Promise<T>
	tracked = gate.then(request).finally(() => {
		ownership.active.delete(tracked)
	})
	ownership.active.add(tracked)
	start()
	void tracked.catch(() => undefined)
	return tracked
}
