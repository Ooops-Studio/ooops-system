type OsModule = {loadavg: () => [number, number, number]}

let osModuleCache: OsModule | null = null
let osModuleLoadingPromise: Promise<void> | null = null

/** Returns the cached Node load average and starts a safe lazy import when needed. */
export function getResourceLoadAverage(
	onError: (error: unknown, details?: Record<string, string>) => void
): [number, number, number] | undefined {
	if (typeof process === 'undefined' || process.platform === 'win32') return undefined
	try {
		if (osModuleCache) {
			return osModuleCache.loadavg()
		}
		if (osModuleLoadingPromise === null) {
			osModuleLoadingPromise = import('os')
				.then((module) => { osModuleCache = {loadavg: () => {
					const load = module.loadavg()
					return [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0]
				}} })
				.catch((error) => {
					osModuleCache = null
					osModuleLoadingPromise = null
					onError(error, {module: 'os'})
				})
		}
	} catch {
		// Load average is optional outside Node and must not affect monitoring.
	}
	return undefined
}
