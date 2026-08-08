import type {MetricState} from './aggregator-state'

export function evictStaleSeries(
	states: Map<string, MetricState>,
	now: number,
	onEvict?: (state: MetricState) => void
): number {
	let evicted = 0
	for (const [key, state] of states) {
		if (state.staleAfterMs !== undefined && Math.max(0, now - state.lastSeenAt) >= state.staleAfterMs) {
			states.delete(key)
			try { onEvict?.(state) } catch { /* eviction observers are isolated */ }
			evicted++
		}
	}
	return evicted
}
