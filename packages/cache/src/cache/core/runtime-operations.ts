import type {CacheEntryMetadata, CacheGetOptions, CacheLoadOptions, CacheSetOptions} from '@ooopsstudio/core/contracts/cache'
import type {CacheBackendPort, CacheServicePort, ManagedCache} from '@ooopsstudio/core/ports/cache'
import {snapshotDenseDataArray, snapshotPlainDataRecord} from '@ooopsstudio/core/utils/validation'

import type {CacheOperationDiagnostic} from './runtime-observability'
import {createTrackedCachePort} from './runtime-port'
import {
	addCacheBatchBytes,
	assertCacheBatchSize,
	createBatchFlightKey,
	createItemFlightKey,
	isCacheTimeoutError,
	snapshotCacheGetOptions,
	snapshotCacheOptions,
	snapshotCacheSetOptions,
	snapshotCacheMap
} from './runtime-safety'
import type {CacheRuntimeTracker} from './runtime-tracking'

type Scope = Partial<CacheLoadOptions> & {namespace?: string}
type Resolved = CacheLoadOptions & {namespace: string; version: string}
type Stored = {value: Uint8Array; metadata: CacheEntryMetadata}
type Lookup<T> = {hit: boolean; stale: boolean; negative: boolean; value?: T; stored?: Stored}
type PreparedEntry = {key: string; value: Uint8Array; metadata: CacheEntryMetadata}
type PublicSetEntry<T> = {key: string; value: T}
const SET_ENTRY_FIELDS = new Set(['key', 'value'])

/** Carries the last cache recheck across every caller joined to one failed source flight. */
class CacheSourceFailure extends Error {
	constructor(
		readonly reason: unknown,
		readonly fallbackEntries: ReadonlyMap<string, Lookup<unknown>> = new Map(),
		readonly authoritative = false,
		readonly recheckFailed = false
	) {
		super('Cache source load failed')
		this.name = 'CacheSourceFailure'
	}
}

export interface CacheOperationContext {
	backend: CacheBackendPort
	tracker: CacheRuntimeTracker
	finalization: Pick<ManagedCache, 'getStatus' | 'flush' | 'shutdown'>
	resolve(scope: Scope, override?: Partial<CacheLoadOptions>): Resolved
	resolveKey(key: string, resolved: Resolved): string
	lookup<T>(scope: Scope, key: string, override?: CacheGetOptions, allowStale?: boolean): Promise<Lookup<T>>
	lookupMany<T>(scope: Scope, keys: readonly string[], override?: CacheGetOptions, allowStale?: boolean): Promise<Map<string, Lookup<T>>>
	setValue<T>(scope: Scope, key: string, value: T, override?: CacheSetOptions, negative?: boolean): Promise<void>
	prepareValue<T>(scope: Scope, key: string, value: T, override?: CacheSetOptions, negative?: boolean): PreparedEntry
	canServeStale<T>(found: Lookup<T>): boolean
	getMutationRevision(key?: string): number
	markMutation(keys?: readonly string[]): void
	runMutation<T>(keys: readonly string[] | undefined, operation: () => Promise<T>): Promise<T>
	isMutationPending(key: string): boolean
	runBackend<T>(operation: string, action: () => Promise<T>, semanticResult?: boolean): Promise<T>
	markBackendSuccess(): void
	reportError(error: unknown, operation: string, attributes?: Record<string, unknown>): void
	metric(name: string, value?: number, labels?: Record<string, string>): void
	measurement(name: string, value: number, labels?: Record<string, string>): void
	diagnosticScope(namespace: string): Record<string, unknown>
	beginOperation(operation: string, attributes?: Record<string, unknown>): CacheOperationDiagnostic
}

function snapshotInvalidationRequest(value: unknown): {
	keys?: readonly string[]
	namespace?: string
	version?: string
} {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Cache invalidate request is invalid')
	}
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const allowed = new Set(['keys', 'namespace', 'version'])
		if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		const keysValue = descriptors.keys?.value
		const namespaceValue = descriptors.namespace?.value
		const versionValue = descriptors.version?.value
		let keySnapshot: string[] | undefined
		if (keysValue !== undefined) {
			keySnapshot = snapshotKeyBatch(keysValue, 'Cache invalidate')
		}
		if (namespaceValue !== undefined && typeof namespaceValue !== 'string') throw new TypeError()
		if (versionValue !== undefined && typeof versionValue !== 'string') throw new TypeError()
		return {
			...(keySnapshot ? {keys: keySnapshot} : {}),
			...(namespaceValue !== undefined ? {namespace: namespaceValue} : {}),
			...(versionValue !== undefined ? {version: versionValue} : {})
		}
	} catch(error) {
		if (error instanceof RangeError) throw error
		throw new TypeError('Cache invalidate request is invalid')
	}
}

function snapshotDenseBatch(value: unknown, operation: string): unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${operation} requires an array`)
	const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
	assertCacheBatchSize(length, operation)
	const result = snapshotDenseDataArray(value, length)
	if (!result) throw new TypeError(`${operation} requires a dense data array`)
	return result
}

function snapshotKeyBatch(value: unknown, operation: string): string[] {
	const entries = snapshotDenseBatch(value, operation)
	if (entries.some((entry) => typeof entry !== 'string')) {
		throw new TypeError(`${operation} keys must be strings`)
	}
	return entries as string[]
}

function snapshotSetBatch<T>(value: unknown): PublicSetEntry<T>[] {
	const entries = snapshotDenseBatch(value, 'Cache setMany')
	return entries.map((entry) => {
		const snapshot = snapshotPlainDataRecord(entry, SET_ENTRY_FIELDS, ['key', 'value'])
		if (!snapshot || typeof snapshot.key !== 'string') {
			throw new TypeError('Cache setMany entries must contain key/value data properties only')
		}
		return {key: snapshot.key, value: snapshot.value as T}
	})
}

export function createScopedCachePort(context: CacheOperationContext, scope: Scope, managed: true): ManagedCache
// eslint-disable-next-line no-redeclare
export function createScopedCachePort(context: CacheOperationContext, scope: Scope, managed?: false): CacheServicePort
// eslint-disable-next-line no-redeclare
export function createScopedCachePort(
	context: CacheOperationContext,
	scope: Scope,
	managed = false
): CacheServicePort | ManagedCache {
	const mergeDefinedOptions = <T extends Partial<CacheLoadOptions>>(base: T | undefined, override: T | undefined): T => {
		const merged = Object.create(null) as Record<string, unknown>
		for (const candidate of [base, override]) {
			const source = snapshotCacheOptions(candidate)
			for (const [key, value] of Object.entries(source)) if (value !== undefined) merged[key] = value
		}
		return merged as T
	}
	const implementation: CacheServicePort = {
		async get<T>(key: string, options?: CacheGetOptions) {
			const safeOptions = snapshotCacheGetOptions(options)
			const found = await context.lookup<T>(scope, key, safeOptions)
			return found.hit && !found.stale && !found.negative ? found.value : undefined
		},
		async getMany<T>(keys: readonly string[], options?: CacheGetOptions) {
			const keySnapshot = snapshotKeyBatch(keys, 'Cache getMany')
			const safeOptions = snapshotCacheGetOptions(options)
			if (keySnapshot.length === 0) {
				context.resolve(scope, safeOptions)
				return new Map<string, T>()
			}
			const found = await context.lookupMany<T>(scope, [...new Set(keySnapshot)], safeOptions)
			const result = new Map<string, T>()
			for (const [key, entry] of found) {
				if (entry.hit && !entry.stale && !entry.negative && entry.value !== undefined) result.set(key, entry.value)
			}
			return result
		},
		async set<T>(key: string, value: T, options?: CacheSetOptions) {
			await context.setValue(scope, key, value, snapshotCacheSetOptions(options))
		},
		async setMany(entries, options) {
			const entrySnapshot = snapshotSetBatch(entries)
			const safeOptions = snapshotCacheSetOptions(options)
			if (entrySnapshot.length === 0) {
				context.resolve(scope, safeOptions)
				return
			}
			const prepared: PreparedEntry[] = []
			let preparedBytes = 0
			for (const entry of entrySnapshot) {
				const item = context.prepareValue(scope, entry.key, entry.value, safeOptions)
				preparedBytes = addCacheBatchBytes(preparedBytes, item.value.byteLength, 'Cache setMany')
				prepared.push(item)
			}
			try {
				context.markMutation(prepared.map((entry) => entry.key))
				await context.runBackend(
					'setMany',
					() => context.runMutation(
						prepared.map((entry) => entry.key),
						() => context.backend.setMany(prepared)
					)
				)
			} catch(error) { context.reportError(error, 'set-many'); throw error }
			if (prepared.length > 0) context.metric('cache_write_total', prepared.length)
			context.measurement('cache_batch_items', prepared.length, {operation: 'set-many'})
			context.measurement('cache_write_size_bytes', preparedBytes, {kind: 'mixed', mode: 'batch'})
		},
		async delete(key, options) {
			const resolved = context.resolve(scope, snapshotCacheGetOptions(options))
			try {
				const resolvedKey = context.resolveKey(key, resolved)
				context.markMutation([resolvedKey])
				const deleted = await context.runBackend(
					'delete', () => context.runMutation([resolvedKey], () => context.backend.delete([resolvedKey])), false
				)
				if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > 1) {
					throw new Error('Cache backend returned an invalid delete result')
				}
				context.markBackendSuccess()
				if (deleted > 0) context.metric('cache_deletes_total', deleted, {operation: 'delete'})
			} catch(error) {
				context.reportError(error, 'delete', context.diagnosticScope(resolved.namespace)); throw error
			}
		},
		async deleteMany(keys, options) {
			const keySnapshot = snapshotKeyBatch(keys, 'Cache deleteMany')
			const resolved = context.resolve(scope, snapshotCacheGetOptions(options))
			if (keySnapshot.length === 0) return
			const resolvedKeys = [...new Set(keySnapshot.map((key) => context.resolveKey(key, resolved)))]
			try {
				context.markMutation(resolvedKeys)
				const deleted = await context.runBackend(
					'deleteMany', () => context.runMutation(resolvedKeys, () => context.backend.delete(resolvedKeys)), false
				)
				if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > resolvedKeys.length) {
					throw new Error('Cache backend returned an invalid deleteMany result')
				}
				context.markBackendSuccess()
				if (deleted > 0) context.metric('cache_deletes_total', deleted, {operation: 'delete-many'})
				context.measurement('cache_batch_items', resolvedKeys.length, {operation: 'delete-many'})
			} catch(error) { context.reportError(error, 'delete-many', context.diagnosticScope(resolved.namespace)); throw error }
		},
		async invalidate(request) {
			const snapshot = snapshotInvalidationRequest(request)
			const resolved = context.resolve(scope, {
				...(snapshot.namespace !== undefined ? {namespace: snapshot.namespace} : {}),
				...(snapshot.version !== undefined ? {version: snapshot.version} : {})
			})
			if (snapshot.keys?.length === 0) return 0
			try {
				const invalidationKeys = snapshot.keys?.map((key) => context.resolveKey(key, resolved))
				context.markMutation(invalidationKeys)
				const invalidated = await context.runBackend('invalidate', () => context.runMutation(
					invalidationKeys,
					() => context.backend.invalidate({
						namespace: resolved.namespace,
						...(snapshot.version !== undefined ? {version: resolved.version} : {}),
						...(invalidationKeys ? {keys: invalidationKeys} : {})
					})
				), false)
				const maximum = snapshot.keys === undefined ? undefined : new Set(snapshot.keys).size
				if (!Number.isSafeInteger(invalidated) || invalidated < 0
					|| (maximum !== undefined && invalidated > maximum)) {
					throw new Error('Cache backend returned an invalid invalidate result')
				}
				context.markBackendSuccess()
				context.metric('cache_invalidations_total', 1, {scope: snapshot.keys ? 'keys' : 'namespace'})
				if (invalidated > 0) context.metric('cache_invalidated_entries_total', invalidated)
				return invalidated
			} catch(error) { context.reportError(error, 'invalidate', context.diagnosticScope(resolved.namespace)); throw error }
		},
		async load<T>(key: string, loader: () => Promise<T>, options?: CacheLoadOptions) {
			if (typeof loader !== 'function') throw new TypeError('Cache load requires a loader function')
			const resolved = context.resolve(scope, options); let found: Lookup<T>; let readTimedOut = false
			try { found = await context.lookup<T>(scope, key, resolved, true) } catch(error) {
				readTimedOut = isCacheTimeoutError(error)
				found = {hit: false, stale: false, negative: false}
			}
			if (found.hit && !found.stale) return found.negative ? undefined as T : found.value as T
			const fullKey = context.resolveKey(key, resolved)
			const callerSnapshotRevision = context.getMutationRevision(fullKey)
			try {
				return await context.tracker.singleFlight(createItemFlightKey(fullKey), async() => {
					let latest: Lookup<T>
					let recheckFailed = false
					try {
						latest = readTimedOut
							? {hit: false, stale: false, negative: false}
							: await context.lookup<T>(scope, key, resolved, true)
					} catch {
						recheckFailed = true
						latest = {hit: false, stale: false, negative: false}
					}
					if (latest.hit && !latest.stale) return latest.negative ? undefined : latest.value
					const mutationRevision = context.getMutationRevision(fullKey)
					let loaded: T
					try {
						loaded = await loader()
						context.metric('cache_loader_total', 1, {operation: 'load', outcome: 'success'})
					} catch(error) {
						context.metric('cache_loader_total', 1, {operation: 'load', outcome: 'failure'})
						let authoritative = context.getMutationRevision(fullKey) === mutationRevision
						let fallback = latest.hit && !latest.negative
							? new Map<string, Lookup<unknown>>([[key, latest as Lookup<unknown>]])
							: new Map<string, Lookup<unknown>>()
						if (!authoritative) {
							fallback = new Map()
							authoritative = true
							try {
								const current = await context.lookup<T>(scope, key, resolved, true)
								fallback = current.hit && !current.negative
									? new Map<string, Lookup<unknown>>([[key, current as Lookup<unknown>]])
									: new Map<string, Lookup<unknown>>()
							} catch { /* a local mutation makes the previous snapshot unsafe */ }
						}
						throw new CacheSourceFailure(error, fallback, authoritative, recheckFailed)
					}
					const unchanged = context.getMutationRevision(fullKey) === mutationRevision
					if (loaded === undefined) {
						if (unchanged && resolved.negativeTtlMs !== undefined) {
							await context.setValue(scope, key, loaded, resolved, true).catch(() => undefined)
						}
						return undefined
					}
					if (unchanged) await context.setValue(scope, key, loaded, resolved).catch(() => undefined)
					return loaded
				})
			} catch(error) {
				const sourceFailure = error instanceof CacheSourceFailure ? error : undefined
				const current = sourceFailure?.fallbackEntries.get(key) as Lookup<T> | undefined
				const callerSnapshotStillValid = context.getMutationRevision(fullKey) === callerSnapshotRevision
				const fallback = current ?? (
					sourceFailure?.recheckFailed && callerSnapshotStillValid
						? found
						: sourceFailure?.authoritative ? undefined : found
				)
				if (resolved.staleIfError && !context.isMutationPending(fullKey) && fallback?.hit && !fallback.negative
					&& (!fallback.stale || context.canServeStale(fallback))) {
					context.metric('cache_stale_fallback_total', 1, {operation: 'load'})
					return fallback.value
				}
				throw sourceFailure?.reason ?? error
			}
		},
		async loadMany<T>(
			keys: readonly string[],
			loader: (missingKeys: readonly string[]) => Promise<ReadonlyMap<string, T>>,
			options?: CacheLoadOptions
		) {
			if (typeof loader !== 'function') throw new TypeError('Cache loadMany requires a loader function')
			const keySnapshot = snapshotKeyBatch(keys, 'Cache loadMany')
			const resolved = context.resolve(scope, options)
			if (keySnapshot.length === 0) return new Map<string, T>()
			const unique = [...new Set(keySnapshot)]
			const result = new Map<string, T>()
			const missing: string[] = []
			const stale = new Map<string, Lookup<T>>()
			let foundByKey: Map<string, Lookup<T>>
			let readTimedOut = false
			// Reuse the authoritative option snapshot. Re-reading caller-controlled
			// options here would let a hostile Proxy change namespace/version between
			// resolution and the initial lookup, crossing cache isolation boundaries.
			try { foundByKey = await context.lookupMany<T>(scope, unique, resolved, true) } catch(error) {
				readTimedOut = isCacheTimeoutError(error)
				foundByKey = new Map(unique.map((key) => [key, {hit: false, stale: false, negative: false}]))
			}
			for (const key of unique) {
				const found = foundByKey.get(key)!
				if (found.hit && !found.stale) {
					if (!found.negative && found.value !== undefined) result.set(key, found.value)
					continue
				}
				if (found.hit && found.stale && !found.negative && found.value !== undefined) stale.set(key, found)
				missing.push(key)
			}
			if (!missing.length) return result
			const callerSnapshotRevisions = new Map(missing.map((key) => {
				const resolvedKey = context.resolveKey(key, resolved)
				return [key, context.getMutationRevision(resolvedKey)] as const
			}))
			const flightKey = createBatchFlightKey(resolved.namespace, resolved.version, missing)
			try {
				const loaded = await context.tracker.singleFlight(flightKey, async() => {
					let latestByKey: Map<string, Lookup<T>>
					let recheckFailed = false
					try {
						latestByKey = readTimedOut
							? new Map(missing.map((key) => [key, {hit: false, stale: false, negative: false}]))
							: await context.lookupMany<T>(scope, missing, resolved, true)
					} catch {
						recheckFailed = true
						latestByKey = new Map(missing.map((key) => [key, {hit: false, stale: false, negative: false}]))
					}
					const values = new Map<string, T>()
					const knownFallback = new Map<string, Lookup<unknown>>()
					const stillMissing: string[] = []
					for (const key of missing) {
						const latest = latestByKey.get(key)!
						if (latest.hit && !latest.stale) {
							if (!latest.negative && latest.value !== undefined) {
								values.set(key, latest.value)
								knownFallback.set(key, latest as Lookup<unknown>)
							}
							continue
						}
						if (context.canServeStale(latest)) knownFallback.set(key, latest as Lookup<unknown>)
						stillMissing.push(key)
					}
					if (stillMissing.length === 0) return values
					// Never expose the internal miss set: readonly is compile-time only and a
					// JavaScript loader could otherwise mutate it to admit unrequested keys.
					const keyMutationRevisions = new Map(stillMissing.map((key) => {
						const resolvedKey = context.resolveKey(key, resolved)
						return [key, context.getMutationRevision(resolvedKey)] as const
					}))
					let loaded: Map<string, T>
					try {
						const candidate = snapshotCacheMap<string, T>(await loader([...stillMissing]))
						const expected = new Set(stillMissing)
						if (!candidate || candidate.size > stillMissing.length
							|| [...candidate.keys()].some((key) => !expected.has(key))) {
							throw new Error('Cache loadMany loader returned an invalid result')
						}
						loaded = candidate
						context.metric('cache_loader_total', 1, {operation: 'load-many', outcome: 'success'})
					} catch(error) {
						context.metric('cache_loader_total', 1, {operation: 'load-many', outcome: 'failure'})
						const fallback = new Map(knownFallback)
						const changedKeys = stillMissing.filter((key) => {
							const resolvedKey = context.resolveKey(key, resolved)
							return context.getMutationRevision(resolvedKey) !== keyMutationRevisions.get(key)
						})
						for (const key of changedKeys) fallback.delete(key)
						if (changedKeys.length > 0) try {
							const current = await context.lookupMany<T>(scope, changedKeys, resolved, true)
							for (const [key, found] of current) {
								if (found.hit && !found.negative) fallback.set(key, found as Lookup<unknown>)
							}
						} catch { /* changed keys remain excluded; unchanged snapshots stay authoritative */ }
						throw new CacheSourceFailure(error, fallback, true, recheckFailed)
					}
					let prepared: PreparedEntry[] | undefined = []
					let preparedBytes = 0
					try {
						for (const key of stillMissing) {
							const resolvedKey = context.resolveKey(key, resolved)
							if (context.getMutationRevision(resolvedKey) !== keyMutationRevisions.get(key)) continue
							const value = loaded.get(key)
							if (value !== undefined) {
								const item = context.prepareValue(scope, key, value, resolved)
								preparedBytes = addCacheBatchBytes(preparedBytes, item.value.byteLength, 'Cache loadMany')
								prepared.push(item)
							}
							else if (resolved.negativeTtlMs !== undefined) {
								const item = context.prepareValue(scope, key, value, resolved, true)
								preparedBytes = addCacheBatchBytes(preparedBytes, item.value.byteLength, 'Cache loadMany')
								prepared.push(item)
							}
						}
					} catch {
						prepared = undefined
						// The loaded application value is still returned. A value that cannot be
						// serialized for caching is a caller-data outcome, not a backend failure.
					}
					if (prepared?.length) try {
						context.markMutation(prepared.map((entry) => entry.key))
						await context.runBackend(
							'loadMany-set',
							() => context.runMutation(
								prepared.map((entry) => entry.key),
								() => context.backend.setMany(prepared)
							)
						)
						context.metric('cache_write_total', prepared.length)
						context.measurement('cache_batch_items', prepared.length, {operation: 'load-many-write'})
						context.measurement('cache_write_size_bytes', preparedBytes, {kind: 'mixed', mode: 'batch'})
					} catch(error) {
						context.reportError(error, 'load-many-write', context.diagnosticScope(resolved.namespace))
					}
					for (const [key, value] of loaded) values.set(key, value)
					return values
				})
				for (const key of missing) {
					const value = loaded.get(key)
					if (value !== undefined) result.set(key, value)
				}
				return result
			} catch(error) {
				const sourceFailure = error instanceof CacheSourceFailure ? error : undefined
				if (resolved.staleIfError) {
					const fallbackByKey = new Map<string, Lookup<T>>()
					if (!sourceFailure?.authoritative || sourceFailure.recheckFailed) {
						for (const [key, found] of stale) {
							const resolvedKey = context.resolveKey(key, resolved)
							if (!sourceFailure?.recheckFailed
								|| context.getMutationRevision(resolvedKey) === callerSnapshotRevisions.get(key)) {
								fallbackByKey.set(key, found)
							}
						}
					}
					for (const [key, found] of sourceFailure?.fallbackEntries ?? []) {
						fallbackByKey.set(key, found as Lookup<T>)
					}
					let served = false
					for (const [key, found] of fallbackByKey) {
						if (context.isMutationPending(context.resolveKey(key, resolved))) continue
						if (!found.hit || found.negative || (found.stale && !context.canServeStale(found))) continue
						result.set(key, found.value as T)
						served = true
					}
					if (served) {
						context.metric('cache_stale_fallback_total', 1, {operation: 'load-many'})
						return result
					}
				}
				throw sourceFailure?.reason ?? error
			}
		},
		namespace(name, defaults) {
			context.tracker.assertActive()
			const nestedScope = {...mergeDefinedOptions(scope, defaults), namespace: name}
			context.resolve(nestedScope)
			return createScopedCachePort(context, nestedScope)
		}
	}
	const tracked = createTrackedCachePort(implementation, context.tracker, context.beginOperation)
	if (!managed) return tracked
	return Object.freeze({
		...tracked,
		getStatus: context.finalization.getStatus,
		flush: context.finalization.flush,
		shutdown: context.finalization.shutdown
	})
}
