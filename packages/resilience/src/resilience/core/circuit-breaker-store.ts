import type {Clock} from '@ooopsstudio/core/contracts/clock'

import type {BreakerStateEntry, CircuitBreakerInspection} from './circuit-breaker-types'
import type {StateIsolationKey} from './internal-types'

export function inspectBreakerEntry(entry: BreakerStateEntry): CircuitBreakerInspection {
	return {
		state: entry.state,
		failures: entry.failures,
		successes: entry.successes,
		windowStart: entry.windowStart,
		lastTransitionTime: entry.lastTransitionTime,
		halfOpenAttempts: entry.halfOpenAttempts,
		generation: entry.gen
	}
}

/** Bounded LRU-like state storage that never evicts active OPEN protection. */
export function createCircuitBreakerStore(options: {
	clock: Clock
	maxStateKeys: number
	createEntry(): BreakerStateEntry
	nextGeneration(): number
	isDestroyed(): boolean
	isReclaimable(entry: BreakerStateEntry): boolean
}) {
	const entries = new Map<StateIsolationKey, BreakerStateEntry>()

	function inspectMissing(): CircuitBreakerInspection {
		const now = options.clock.now()
		const capacityProtected = entries.size >= options.maxStateKeys
			&& [...entries.values()].every((entry) => !options.isReclaimable(entry))
		return {
			state: capacityProtected ? 'OPEN' : 'CLOSED',
			failures: 0,
			successes: 0,
			windowStart: now,
			lastTransitionTime: now,
			halfOpenAttempts: 0,
			generation: capacityProtected ? -1 : options.nextGeneration()
		}
	}

	function getOrCreate(key: StateIsolationKey): BreakerStateEntry | undefined {
		if (options.isDestroyed()) return undefined
		let entry = entries.get(key)
		if (!entry) {
			if (entries.size >= options.maxStateKeys) {
				let evictableKey: StateIsolationKey | undefined
				for (const [candidateKey, candidate] of entries) {
					if (options.isReclaimable(candidate) && entries.get(candidateKey) === candidate) {
						evictableKey = candidateKey
						break
					}
				}
				if (options.isDestroyed() || evictableKey === undefined) return undefined
				entries.delete(evictableKey)
			}
			entry = options.createEntry()
			if (options.isDestroyed()) return undefined
			const reentrantEntry = entries.get(key)
			if (reentrantEntry) return reentrantEntry
			if (entries.size >= options.maxStateKeys) return undefined
			entries.set(key, entry)
		} else {
			entries.delete(key)
			entries.set(key, entry)
		}
		return entry
	}

	return {entries, getOrCreate, inspectMissing}
}
