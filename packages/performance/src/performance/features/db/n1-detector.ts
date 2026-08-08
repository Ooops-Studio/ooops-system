import type {N1Pattern, PerfEvent} from '@ooopsstudio/core/contracts/performance'

import {cloneN1Event, cloneN1Pattern, detectN1Patterns} from './n1-patterns'

export interface N1DetectorOptions {
	timeWindowMs?: number
	minDuplicates?: number
	maxTrackedTraces?: number
	maxEventsPerTrace?: number
	enabled: true
}

export interface N1Detector {
	check(event: PerfEvent): N1Pattern[]
	detectPatterns(events: PerfEvent[]): N1Pattern[]
	reset(): void
}

const MAX_PATTERNS = 10

export function createN1Detector(options: N1DetectorOptions): N1Detector {
	const {
		timeWindowMs = 1_000,
		minDuplicates = 3,
		maxTrackedTraces = 100,
		maxEventsPerTrace = 100,
		enabled
	} = options
	if (enabled !== true) throw new Error('N+1 detection requires enabled: true')
	if (!Number.isFinite(timeWindowMs) || timeWindowMs <= 0) {
		throw new Error('timeWindowMs must be a positive finite number')
	}
	if (!Number.isInteger(minDuplicates) || minDuplicates < 2) {
		throw new Error('minDuplicates must be an integer of at least 2')
	}
	if (!Number.isInteger(maxTrackedTraces) || maxTrackedTraces <= 0 || maxTrackedTraces > 1_000) {
		throw new Error('maxTrackedTraces must be 1..1000')
	}
	if (!Number.isInteger(maxEventsPerTrace) || maxEventsPerTrace < minDuplicates || maxEventsPerTrace > 256) {
		throw new Error('maxEventsPerTrace must be minDuplicates..256')
	}
	if (maxTrackedTraces * maxEventsPerTrace > 10_000) {
		throw new Error('N+1 detection supports at most 10000 retained events')
	}

	const traces = new Map<string, {events: PerfEvent[]; fingerprints: Set<string>; lastSeen: number}>()
	const detectionOptions = {timeWindow: timeWindowMs, minDuplicates}
	const cleanupIntervalMs = Math.max(1_000, Math.min(timeWindowMs * 10, 60_000))
	let nextCleanupAt = Number.NEGATIVE_INFINITY
	const validTraceId = (value: unknown): value is string =>
		typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value)
	const prune = (timestamp: number) => {
		if (timestamp >= nextCleanupAt) {
			for (const [traceId, state] of traces) {
				if (timestamp - state.lastSeen > timeWindowMs * 10) traces.delete(traceId)
			}
			nextCleanupAt = timestamp + cleanupIntervalMs
		}
	}

	return {
		check(event) {
			if (!enabled || !event.name.startsWith('db.') || !validTraceId(event.traceId)) return []
			prune(event.end)
			let state = traces.get(event.traceId)
			if (!state) {
				while (traces.size >= maxTrackedTraces) {
					const oldest = traces.keys().next().value as string | undefined
					if (!oldest) break
					traces.delete(oldest)
				}
				state = {events: [], fingerprints: new Set(), lastSeen: event.end}
				traces.set(event.traceId, state)
			}
			state.lastSeen = Math.max(state.lastSeen, event.end)
			state.events.push(cloneN1Event(event))
			if (state.events.length > maxEventsPerTrace) state.events.shift()
			const fresh: N1Pattern[] = []
			for (const pattern of detectN1Patterns(state.events, detectionOptions, state.fingerprints)) {
				const fingerprint = `${pattern.type}:${pattern.querySignature}`
				if (state.fingerprints.has(fingerprint)) continue
				if (state.fingerprints.size >= MAX_PATTERNS) break
				state.fingerprints.add(fingerprint)
				fresh.push(cloneN1Pattern(pattern))
			}
			return fresh
		},
		detectPatterns(events) {
			return detectN1Patterns(events, detectionOptions).map(cloneN1Pattern)
		},
		reset() {
			traces.clear()
			nextCleanupAt = Number.NEGATIVE_INFINITY
		}
	}
}
