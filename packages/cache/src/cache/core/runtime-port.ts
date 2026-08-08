import type {CacheGetOptions, CacheLoadOptions, CacheSetOptions} from '@ooopsstudio/core/contracts/cache'
import type {CacheServicePort} from '@ooopsstudio/core/ports/cache'

import type {CacheOperationDiagnostic} from './runtime-observability'
import type {CacheRuntimeTracker} from './runtime-tracking'

export function createTrackedCachePort(
	implementation: CacheServicePort,
	tracker: CacheRuntimeTracker,
	beginOperation?: (operation: string, attributes?: Record<string, unknown>) => CacheOperationDiagnostic
): CacheServicePort {
	const safeItemCount = (value: unknown): number => {
		try {
			if (!Array.isArray(value)) return 0
			const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
			return Number.isSafeInteger(length) && length >= 0 ? Number(length) : 0
		} catch { return 0 }
	}
	const observe = <T>(operation: string, attributes: Record<string, unknown>, action: () => Promise<T>): Promise<T> => {
		const diagnostic = beginOperation?.(operation, attributes)
		let pending: Promise<T>
		try { pending = action() } catch(error) { pending = Promise.reject(error) }
		return pending.then(
			(result) => { diagnostic?.complete(); return result },
			(error: unknown) => { diagnostic?.fail(); throw error }
		)
	}
	const run = <T>(operation: string, attributes: Record<string, unknown>, action: () => Promise<T>): Promise<T> =>
		observe(operation, attributes, () => tracker.run(action))
	return {
		get: <T>(key: string, options?: CacheGetOptions) => run('get', {}, () => implementation.get<T>(key, options)),
		getMany: <T>(keys: readonly string[], options?: CacheGetOptions) =>
			run('get-many', {itemCount: safeItemCount(keys)}, () => implementation.getMany<T>(keys, options)),
		set: <T>(key: string, value: T, options?: CacheSetOptions) =>
			run('set', {}, () => implementation.set(key, value, options)),
		setMany: <T>(
			entries: ReadonlyArray<{key: string; value: T}>,
			options?: CacheSetOptions
		) => run('set-many', {itemCount: safeItemCount(entries)}, () => implementation.setMany(entries, options)),
		delete: (key, options) => run('delete', {}, () => implementation.delete(key, options)),
		deleteMany: (keys, options) =>
			run('delete-many', {itemCount: safeItemCount(keys)}, () => implementation.deleteMany(keys, options)),
		invalidate: (request) => run('invalidate', {}, () => implementation.invalidate(request)),
		load: <T>(key: string, loader: () => Promise<T>, options?: CacheLoadOptions) =>
			run('load', {}, () => implementation.load(key, loader, options)),
		loadMany: <T>(
			keys: readonly string[],
			loader: (missingKeys: readonly string[]) => Promise<ReadonlyMap<string, T>>,
			options?: CacheLoadOptions
		) => run('load-many', {itemCount: safeItemCount(keys)}, () => implementation.loadMany(keys, loader, options)),
		namespace(name, defaults) {
			const diagnostic = beginOperation?.('namespace', {})
			try { const scoped = implementation.namespace(name, defaults); diagnostic?.complete(); return scoped } catch(error) {
				diagnostic?.fail(); throw error
			}
		}
	}
}
