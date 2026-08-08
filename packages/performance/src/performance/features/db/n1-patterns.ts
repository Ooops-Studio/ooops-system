import type {N1Pattern, PerfEvent} from '@ooopsstudio/core/contracts/performance'

export interface N1PatternDetectionOptions {
	timeWindow: number
	minDuplicates: number
}

type DetectedN1Pattern = N1Pattern & {events: readonly PerfEvent[]}

const firstString = (...values: unknown[]): string | undefined =>
	values.find((value): value is string => typeof value === 'string')

const queryCollection = (event: PerfEvent): string | undefined =>
	firstString(event.dbMetadata?.collection, event.dbMetadata?.table, event.labels?.collection)

const queryMethod = (event: PerfEvent): string | undefined =>
	firstString(event.dbMetadata?.method, event.dbMetadata?.operation, event.labels?.method)

const normalizeQuerySignature = (event: PerfEvent): string => {
	const parts: string[] = [event.name]
	const collection = queryCollection(event)
	const method = queryMethod(event)
	if (collection) parts.push(`collection:${collection}`)
	if (method) parts.push(`method:${method}`)
	if (typeof event.dbMetadata?.queryHash === 'string') parts.push(`query_hash:${event.dbMetadata.queryHash}`)
	if (event.labels?.filter_type) parts.push(`filter_type:${event.labels.filter_type}`)
	return parts.sort().join('|')
}

export const cloneN1Event = (event: PerfEvent): PerfEvent => {
	const bounded = (value: string | undefined) => value?.slice(0, 128)
	return {
		name: event.name,
		duration: event.duration,
		start: event.start,
		end: event.end,
		source: event.source,
		dbMetadata: {
			collection: bounded(queryCollection(event)),
			operation: bounded(queryMethod(event)),
			queryHash: bounded(event.dbMetadata?.queryHash)
		},
		labels: {filter_type: bounded(event.labels?.filter_type) ?? ''}
	}
}

export const cloneN1Pattern = (pattern: DetectedN1Pattern): N1Pattern => ({
	type: pattern.type,
	duplicateCount: pattern.duplicateCount,
	querySignature: pattern.querySignature,
	...(pattern.collection ? {collection: pattern.collection} : {}),
	...(pattern.method ? {method: pattern.method} : {}),
	timeWindow: pattern.timeWindow,
	...(pattern.suggestion ? {suggestion: pattern.suggestion} : {})
})

const groupBySignature = (events: readonly PerfEvent[]) => {
	const signatures = new Map<string, PerfEvent[]>()
	for (const event of events) {
		if (!event.name.startsWith('db.')) continue
		const signature = normalizeQuerySignature(event)
		const matchingEvents = signatures.get(signature) ?? []
		matchingEvents.push(event)
		signatures.set(signature, matchingEvents)
	}
	return signatures
}

const detectSignaturePatterns = (
	events: readonly PerfEvent[],
	options: N1PatternDetectionOptions,
	type: Extract<N1Pattern['type'], 'identical-queries' | 'repeated-queries'>,
	knownFingerprints?: ReadonlySet<string>
): DetectedN1Pattern[] => {
	const patterns: DetectedN1Pattern[] = []
	const maximumWindow = options.timeWindow * (type === 'identical-queries' ? 1 : 10)
	for (const [signature, matchingEvents] of groupBySignature(events)) {
		if (matchingEvents.length < options.minDuplicates) continue
		if (knownFingerprints?.has(`${type}:${signature}`)) continue
		const sortedEvents = [...matchingEvents].sort((a, b) => a.start - b.start)
		const firstEvent = sortedEvents[0]
		const lastEvent = sortedEvents.at(-1)
		if (!firstEvent || !lastEvent) continue
		const eventWindow = lastEvent.end - firstEvent.start
		if (eventWindow > maximumWindow) continue
		if (type === 'repeated-queries' && eventWindow <= options.timeWindow) continue
		const collection = queryCollection(firstEvent)
		const method = queryMethod(firstEvent)
		patterns.push({
			type,
			duplicateCount: matchingEvents.length,
			querySignature: signature,
			...(collection ? {collection} : {}),
			...(method ? {method} : {}),
			timeWindow: eventWindow,
			events: matchingEvents,
			suggestion: type === 'identical-queries'
				? `Consider batching ${matchingEvents.length} identical queries into a single request`
				: `Consider caching results for ${matchingEvents.length} repeated queries`
		})
	}
	return patterns
}

const detectQueryWaterfall = (
	events: readonly PerfEvent[],
	options: N1PatternDetectionOptions,
	knownFingerprints?: ReadonlySet<string>
): DetectedN1Pattern[] => {
	const dbEvents = events.filter((event) => event.name.startsWith('db.')).sort((a, b) => a.start - b.start)
	if (dbEvents.length < options.minDuplicates) return []
	const collections = dbEvents.map(queryCollection)
	const methods = dbEvents.map(queryMethod)
	const sequentialBreaks = new Array<number>(dbEvents.length).fill(0)
	for (let index = 1; index < dbEvents.length; index += 1) {
		sequentialBreaks[index] = sequentialBreaks[index - 1]!
			+ (dbEvents[index]!.start < dbEvents[index - 1]!.end ? 1 : 0)
	}
	const collectionCounts = new Map<string, number>()
	const methodCounts = new Map<string, number>()
	const adjust = (counts: Map<string, number>, value: string | undefined, delta: 1 | -1) => {
		if (!value) return
		const next = (counts.get(value) ?? 0) + delta
		if (next === 0) counts.delete(value)
		else counts.set(value, next)
	}
	for (let index = 0; index < options.minDuplicates; index += 1) {
		adjust(collectionCounts, collections[index], 1)
		adjust(methodCounts, methods[index], 1)
	}
	for (let index = 0; index <= dbEvents.length - options.minDuplicates; index += 1) {
		const endIndex = index + options.minDuplicates - 1
		const firstEvent = dbEvents[index]
		const lastEvent = dbEvents[endIndex]
		if (!firstEvent || !lastEvent) continue
		const sequentialBreakCount = sequentialBreaks[endIndex]! - sequentialBreaks[index]!
		const windowDuration = lastEvent.end - firstEvent.start
		if (sequentialBreakCount === 0 && windowDuration <= options.timeWindow * 2
			&& collectionCounts.size === 1 && methodCounts.size === 1) {
			const collection = queryCollection(firstEvent)
			const method = queryMethod(firstEvent)
			const signature = `${collection ?? 'unknown'}:${method ?? 'unknown'}`
			if (!knownFingerprints?.has(`query-waterfall:${signature}`)) {
				return [{
					type: 'query-waterfall',
					duplicateCount: options.minDuplicates,
					querySignature: signature,
					...(collection ? {collection} : {}),
					...(method ? {method} : {}),
					timeWindow: windowDuration,
					events: dbEvents.slice(index, endIndex + 1),
					suggestion: `Consider batching ${options.minDuplicates} sequential queries into a single request with filters`
				}]
			}
		}
		adjust(collectionCounts, collections[index], -1)
		adjust(methodCounts, methods[index], -1)
		adjust(collectionCounts, collections[endIndex + 1], 1)
		adjust(methodCounts, methods[endIndex + 1], 1)
	}
	return []
}

const detectOverFetching = (
	events: readonly PerfEvent[],
	options: N1PatternDetectionOptions,
	knownFingerprints?: ReadonlySet<string>
): DetectedN1Pattern[] => {
	const collections = new Map<string, PerfEvent[]>()
	for (const event of events) {
		const collection = queryCollection(event)
		if (!event.name.startsWith('db.') || !collection) continue
		const matchingEvents = collections.get(collection) ?? []
		matchingEvents.push(event)
		collections.set(collection, matchingEvents)
	}
	const patterns: DetectedN1Pattern[] = []
	for (const [collection, matchingEvents] of collections) {
		if (matchingEvents.length < options.minDuplicates) continue
		if (knownFingerprints?.has(`over-fetching:collection:${collection}`)) continue
		const sortedEvents = [...matchingEvents].sort((a, b) => a.start - b.start)
		const firstEvent = sortedEvents[0]
		const lastEvent = sortedEvents.at(-1)
		if (!firstEvent || !lastEvent) continue
		const eventWindow = lastEvent.end - firstEvent.start
		if (eventWindow > options.timeWindow) continue
		patterns.push({
			type: 'over-fetching',
			duplicateCount: matchingEvents.length,
			querySignature: `collection:${collection}`,
			collection,
			timeWindow: eventWindow,
			events: matchingEvents,
			suggestion: `Consider consolidating ${matchingEvents.length} queries to collection "${collection}"`
		})
	}
	return patterns
}

export const detectN1Patterns = (
	events: readonly PerfEvent[],
	options: N1PatternDetectionOptions,
	knownFingerprints?: ReadonlySet<string>
): DetectedN1Pattern[] => [
	...detectSignaturePatterns(events, options, 'identical-queries', knownFingerprints),
	...detectSignaturePatterns(events, options, 'repeated-queries', knownFingerprints),
	...detectQueryWaterfall(events, options, knownFingerprints),
	...detectOverFetching(events, options, knownFingerprints)
]
