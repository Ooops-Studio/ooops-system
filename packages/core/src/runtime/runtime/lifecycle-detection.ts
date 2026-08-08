/** Runtime classification only. Process lifecycle ownership belongs to services/lifecycle/node. */
export type RuntimeType = 'node:prod' | 'node:dev' | 'node:test' | 'browser' | 'deno' | 'unknown'

export function detectRuntime(): RuntimeType {
	try {
		if (typeof process !== 'undefined' && process.versions?.node) {
			const environment = process.env.NODE_ENV
			if (environment === 'test') return 'node:test'
			if (environment === 'production' || environment === 'prod') return 'node:prod'
			return 'node:dev'
		}
	} catch { /* Continue with non-Node classification. */ }
	const runtime = globalThis as typeof globalThis & {Deno?: unknown; window?: unknown; self?: unknown}
	try { if (runtime.Deno !== undefined) return 'deno' } catch { /* Ignore poisoned runtime markers. */ }
	try { if (runtime.window !== undefined) return 'browser' } catch { /* Inspect self independently. */ }
	try { if (runtime.self !== undefined) return 'browser' } catch { /* Fall back to unknown. */ }
	return 'unknown'
}
