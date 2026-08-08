export interface CapturedPrometheusScrape {
	readonly body: string
	readonly contentType: string
}

export type PrometheusScrapeCapability = (
	format?: 'openmetrics' | 'prometheus'
) => CapturedPrometheusScrape

/** Capture an optional scrape method once without invoking caller accessors. */
export function capturePrometheusScrapeCapability(
	source: unknown
): PrometheusScrapeCapability | undefined {
	if (!source || (typeof source !== 'object' && typeof source !== 'function')) return undefined
	let cursor: object | null = source as object
	const visited = new Set<object>()
	try {
		while (cursor && !visited.has(cursor) && visited.size < 32) {
			visited.add(cursor)
			const descriptor = Object.getOwnPropertyDescriptor(cursor, 'getPrometheusScrape')
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as PrometheusScrapeCapability
				return (format) => Reflect.apply(method, source, [format]) as CapturedPrometheusScrape
			}
			cursor = Object.getPrototypeOf(cursor) as object | null
		}
	} catch {
		return undefined
	}
	return undefined
}
