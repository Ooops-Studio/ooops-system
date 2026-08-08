import type {MetricRecord} from '../../types/metric-record'

export function applyPrometheusRollingWindow(options: {
	readonly samples: Map<string, MetricRecord>;
	readonly maxBytes: number;
	readonly maxLines: number;
	readonly render: (records: ReadonlyArray<MetricRecord>) => string;
	readonly familyKey: (record: MetricRecord) => string;
	readonly sampleBytes: (record: MetricRecord) => number;
	readonly rebuildIndexes: () => void;
}): void {
	let removedInvalid = false
	for (const [key, record] of options.samples) {
		if (record) continue
		options.samples.delete(key)
		removedInvalid = true
	}
	const entries = [...options.samples.entries()]
	const classified = entries.map(([key, record]) => ({
		key,
		record,
		family: options.familyKey(record),
		bytes: options.sampleBytes(record)
	}))
	const fits = (candidate: ReadonlyArray<(typeof classified)[number]>): boolean => {
		// Preserve the previous behavior: an empty rolling window is terminal even
		// when fixed exposition framing alone exceeds a caller's tiny limit.
		if (candidate.length === 0) return true
		if (candidate.reduce((total, {bytes}) => total + bytes, 0) > options.maxBytes) return false
		const records = candidate.map(({record}) => record)
		const rendered = options.render(records)
		return Buffer.byteLength(rendered, 'utf8') <= options.maxBytes
			&& rendered.split('\n').length <= options.maxLines
	}
	if (fits(classified)) {
		if (removedInvalid) options.rebuildIndexes()
		return
	}

	const orderedFamilies: string[] = []
	const seenFamilies = new Set<string>()
	for (const {family} of classified) {
		if (!seenFamilies.has(family)) {
			seenFamilies.add(family)
			orderedFamilies.push(family)
		}
	}
	let lower = 1
	let upper = orderedFamilies.length
	while (lower < upper) {
		const middle = Math.floor((lower + upper) / 2)
		const evicted = new Set(orderedFamilies.slice(0, middle))
		const candidate = classified.filter(({family}) => !evicted.has(family))
		if (fits(candidate)) upper = middle
		else lower = middle + 1
	}
	const evicted = new Set(orderedFamilies.slice(0, lower))
	for (const {key, family} of classified) {
		if (evicted.has(family)) options.samples.delete(key)
	}
	options.rebuildIndexes()
}
