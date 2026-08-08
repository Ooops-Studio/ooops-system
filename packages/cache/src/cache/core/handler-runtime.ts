import type {CacheEntryMetadata, CacheGetOptions, CacheLoadOptions, CacheSetOptions} from '@ooopsstudio/core/contracts/cache'
import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CacheBackendPort, ManagedCache} from '@ooopsstudio/core/ports/cache'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {registerCacheTelemetryTarget} from '../runtime-capabilities'

import {bindCacheBackendPort, bindCacheClock, captureCacheCapability} from './runtime-backend-binding'
import {createCacheFinalization} from './runtime-finalization'
import {createCacheEntryMetadata, projectCacheStoredEntry} from './runtime-metadata'
import {createCacheMutationCoordinator} from './runtime-mutations'
import {createCacheRuntimeObservability} from './runtime-observability'
import {createScopedCachePort} from './runtime-operations'
import {
	addCacheBatchBytes,
	CACHE_BACKEND_OPERATION_TIMEOUT_MS,
	isCacheTimeoutError,
	MAX_UNRESOLVED_CACHE_BACKEND_OPERATIONS,
	readCacheTimestamp,
	resolveCacheStorageKey,
	snapshotCacheOptions,
	snapshotCacheMap,
	validateCacheComponent,
	validateCacheDuration,
	withCacheTimeout
} from './runtime-safety'
import {decodeCacheValue, encodeCacheValue, isEncodedNegativeCacheValue} from './runtime-serialization'
import {createCacheRuntimeTracker} from './runtime-tracking'

export interface CacheHandlerOptions {
	clock: Clock
	backend: CacheBackendPort
	defaultNamespace?: string
	ttlJitterRatio?: number
	lifecycle?: LifecyclePort
}

type Scope = Partial<CacheLoadOptions> & {namespace?: string}
type Resolved = CacheLoadOptions & {namespace: string; version: string}
type Stored = {value: Uint8Array; metadata: CacheEntryMetadata}
type Lookup<T> = {hit: boolean; stale: boolean; negative: boolean; value?: T; stored?: Stored}

export function createCacheHandler(options: CacheHandlerOptions): ManagedCache {
	if (!options) throw new Error('Cache requires a clock')
	const clock = bindCacheClock(options.clock, 'Cache')
	const backend = bindCacheBackendPort(options.backend)
	const registerFlushHook = captureCacheCapability<
		Parameters<NonNullable<LifecyclePort['registerFlushHook']>>,
		ReturnType<NonNullable<LifecyclePort['registerFlushHook']>>
	>(options.lifecycle, 'registerFlushHook')
	const registerShutdownHook = captureCacheCapability<
		Parameters<NonNullable<LifecyclePort['registerShutdownHook']>>,
		ReturnType<NonNullable<LifecyclePort['registerShutdownHook']>>
	>(options.lifecycle, 'registerShutdownHook')
	const jitterRatio = options.ttlJitterRatio ?? 0
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 0.5) throw new Error('Cache ttlJitterRatio must be between 0 and 0.5')
	const defaultNamespace = options.defaultNamespace ?? 'default'
	validateCacheComponent(defaultNamespace, 'Cache namespace')
	const observability = createCacheRuntimeObservability()
	const {
		reportError, metric, measurement, diagnosticScope, beginOperation,
		markBackendSuccess, markBackendTimeout, markBackendSettlement, markFinalizationSuccess, markDropped
	} = observability
	let mutationRevision = 0
	let broadMutationRevision = 0
	const keyMutationRevisions = new Map<string, number>()
	const markMutation = (keys?: readonly string[]): void => {
		if (mutationRevision >= Number.MAX_SAFE_INTEGER) {
			mutationRevision = 1
			broadMutationRevision = 1
			keyMutationRevisions.clear()
		} else mutationRevision++
		if (!keys) {
			broadMutationRevision = mutationRevision
			keyMutationRevisions.clear()
			return
		}
		for (const key of keys) {
			keyMutationRevisions.delete(key)
			keyMutationRevisions.set(key, mutationRevision)
		}
		if (keyMutationRevisions.size > 1_000) {
			broadMutationRevision = mutationRevision
			keyMutationRevisions.clear()
		}
	}
	const getMutationRevision = (key?: string): number => key === undefined
		? mutationRevision
		: Math.max(broadMutationRevision, keyMutationRevisions.get(key) ?? 0)
	const tracker = createCacheRuntimeTracker(
		() => markDropped('capacity'),
		(event, activeFlights) => {
			metric('cache_single_flight_events_total', 1, {event})
			measurement('cache_single_flight_active', activeFlights)
		},
		(activeOperations) => measurement('cache_active_operations', activeOperations, {scope: 'service'})
	)
	const pendingBackendOperations = new Set<Promise<unknown>>()
	const mutationCoordinator = createCacheMutationCoordinator(() => markDropped('capacity'))
	const assertBackendOperationCapacity = (): void => {
		// Every pending backend promise can eventually outlive its public timeout.
		// Reserving capacity only after a timeout lets a concurrent burst admit an
		// unbounded number of permanently unresolved promises before the first timer
		// fires. Bound admission itself so lifecycle draining retains a hard limit.
		if (pendingBackendOperations.size >= MAX_UNRESOLVED_CACHE_BACKEND_OPERATIONS) {
			throw new Error('Cache backend unresolved operation capacity exceeded')
		}
	}
	const trackBackendOperation = <T>(raw: Promise<T>): Promise<T> => {
		pendingBackendOperations.add(raw)
		void raw.then(
			() => pendingBackendOperations.delete(raw),
			() => pendingBackendOperations.delete(raw)
		)
		return raw
	}
	const finalization = createCacheFinalization({
		backend,
		tracker,
		trackBackendOperation,
		assertBackendOperationCapacity,
		waitForBackendOperations: async() => {
			await Promise.allSettled([...pendingBackendOperations])
		},
		reportError,
		markBackendSuccess,
		markBackendTimeout,
		markBackendSettlement,
		markFinalizationSuccess,
		recover: observability.recover,
		snapshot: observability.snapshot,
		getMutationRevision: () => mutationRevision
	})
	const runBackend = <T>(operation: string, action: () => Promise<T>, semanticResult = true): Promise<T> => {
		const metricOperation = operation.replace(/[^a-z0-9-]/giu, '-').slice(0, 64)
		const diagnostic = beginOperation(`backend-${operation}`, {}, 'trace')
		let timedOut = false
		try { assertBackendOperationCapacity() } catch(error) {
			diagnostic.fail()
			return Promise.reject(error)
		}
		let pending: Promise<T>
		// Reserve coordinator work before the public call returns. Deferring action
		// invocation by one microtask lets a later read miss an accepted mutation.
		try { pending = Promise.resolve(action()) } catch(error) { pending = Promise.reject(error) }
		const raw = trackBackendOperation(pending)
		return withCacheTimeout(
			raw,
			CACHE_BACKEND_OPERATION_TIMEOUT_MS,
			`Cache backend ${operation} timed out after ${CACHE_BACKEND_OPERATION_TIMEOUT_MS}ms`
		).then(
			(result) => {
				diagnostic.complete()
				if (semanticResult) markBackendSuccess()
				return result
			},
			(error: unknown) => {
				timedOut = isCacheTimeoutError(error)
				if (timedOut) {
					markBackendTimeout()
					metric('cache_backend_timeouts_total', 1, {operation: metricOperation})
					void raw.then(
						() => {
							markBackendSettlement(true)
							metric('cache_backend_late_settlements_total', 1, {operation: metricOperation, outcome: 'success'})
						},
						() => {
							markBackendSettlement(false)
							metric('cache_backend_late_settlements_total', 1, {operation: metricOperation, outcome: 'failure'})
						}
					)
				}
				diagnostic.fail({timedOut})
				throw error
			}
		)
	}
	const resolve = (scope: Scope, override?: Partial<CacheLoadOptions>): Resolved => {
		const scopeSnapshot = snapshotCacheOptions(scope, 'Cache scope')
		const overrideSnapshot = snapshotCacheOptions(override)
		const namespace = overrideSnapshot.namespace ?? scopeSnapshot.namespace ?? defaultNamespace
		validateCacheComponent(namespace, 'Cache namespace')
		const merged: Partial<CacheLoadOptions> & {namespace: string; version: string} = {
			namespace,
			version: overrideSnapshot.version ?? scopeSnapshot.version ?? 'v1'
		}
		for (const candidate of [scopeSnapshot, overrideSnapshot]) {
			const source = snapshotCacheOptions(candidate)
			for (const [key, value] of Object.entries(source)) {
				if (value !== undefined) (merged as Record<string, unknown>)[key] = value
			}
		}
		merged.namespace = namespace
		merged.version = overrideSnapshot.version ?? scopeSnapshot.version ?? 'v1'
		validateCacheComponent(merged.version, 'Cache version')
		validateCacheDuration(merged.ttlMs, 'Cache ttlMs')
		validateCacheDuration(merged.staleTtlMs, 'Cache staleTtlMs')
		validateCacheDuration(merged.negativeTtlMs, 'Cache negativeTtlMs')
		if (merged.staleIfError !== undefined && typeof merged.staleIfError !== 'boolean') {
			throw new TypeError('Cache staleIfError must be a boolean')
		}
		if (merged.staleTtlMs !== undefined && merged.ttlMs === undefined) throw new Error('Cache staleTtlMs requires ttlMs')
		return merged as Resolved
	}
	const resolveKey = (key: string, resolved: Resolved): string => {
		validateCacheComponent(key, 'Cache key')
		return resolveCacheStorageKey(resolved.namespace, resolved.version, key)
	}
	const createMetadata = (key: string, fullKey: string, resolved: Resolved, value: Uint8Array, negative: boolean): CacheEntryMetadata => {
		return createCacheEntryMetadata({
			clock,
			key,
			resolvedKey: fullKey,
			resolved,
			value,
			negative,
			jitterRatio
		})
	}
	const lookup = async<T>(scope: Scope, key: string, override?: CacheGetOptions, allowStale = false): Promise<Lookup<T>> => {
		const resolved = resolve(scope, override)
		const fullKey = resolveKey(key, resolved)
		const logLookup = (outcome: string, attributes: Record<string, unknown> = {}): void => {
			metric('cache_lookups_total', 1, {
				outcome,
				freshness: attributes.stale === true ? 'stale' : outcome === 'hit' ? 'fresh' : 'none',
				kind: attributes.negative === true ? 'negative' : outcome === 'hit' ? 'positive' : 'none',
				reason: typeof attributes.reason === 'string' ? attributes.reason : 'none'
			})
		}
		let candidate: unknown
		try { candidate = await runBackend('get', async() => {
			await mutationCoordinator.wait([fullKey])
			return await backend.get(fullKey, {
				namespace: resolved.namespace,
				version: resolved.version,
				allowStale
			})
		}, false) } catch(error) {
			reportError(error, 'get', diagnosticScope(resolved.namespace)); throw error
		}
		if (candidate === undefined) {
			markBackendSuccess()
			metric('cache_miss_total'); logLookup('miss', {reason: 'absent'})
			return {hit: false, stale: false, negative: false}
		}
		const stored = projectCacheStoredEntry(candidate)
		if (!stored || stored.metadata.key !== key
			|| stored.metadata.namespace !== resolved.namespace
			|| stored.metadata.version !== resolved.version) {
			reportError(new Error('Cache backend returned an invalid entry'), 'invalid-entry')
			metric('cache_miss_total')
			metric('cache_corrupt_entries_total', 1, {operation: 'get', reason: 'invalid-entry'})
			logLookup('miss', {reason: 'invalid-entry'})
			return {hit: false, stale: false, negative: false}
		}
		const now = readCacheTimestamp(clock)
		if (stored.metadata.expiresAt !== undefined && stored.metadata.expiresAt <= now) {
			reportError(new Error('Cache backend returned an expired entry'), 'expired-entry')
			metric('cache_miss_total')
			metric('cache_expired_entries_total', 1, {operation: 'get'})
			logLookup('miss', {reason: 'expired-entry'})
			return {hit: false, stale: false, negative: false}
		}
		const stale = stored.metadata.staleAt !== undefined && stored.metadata.staleAt <= now
		if (stored.metadata.negative && !isEncodedNegativeCacheValue(stored.value)) {
			reportError(new Error('Cache backend returned an invalid negative entry'), 'invalid-negative-entry')
			metric('cache_miss_total'); logLookup('miss', {reason: 'invalid-negative-entry'})
			metric('cache_corrupt_entries_total', 1, {operation: 'get', reason: 'invalid-negative-entry'})
			return {hit: false, stale: false, negative: false}
		}
		if (stored.metadata.negative) {
			markBackendSuccess()
			metric(stale ? 'cache_stale_hit_total' : 'cache_hit_total')
			metric('cache_negative_hit_total')
			logLookup('hit', {stale, negative: true, sizeBytes: stored.metadata.sizeBytes})
			return {hit: true, stale, negative: true, stored}
		}
		try {
			const value = decodeCacheValue<T>(stored.value)
			markBackendSuccess()
			metric(stale ? 'cache_stale_hit_total' : 'cache_hit_total')
			logLookup('hit', {stale, negative: false, sizeBytes: stored.metadata.sizeBytes})
			return {hit: true, stale, negative: false, value, stored}
		} catch(error) {
			reportError(error, 'decode', diagnosticScope(resolved.namespace))
			metric('cache_miss_total')
			metric('cache_corrupt_entries_total', 1, {operation: 'get', reason: 'decode-failure'})
			logLookup('miss', {reason: 'decode-failure'})
			return {hit: false, stale: false, negative: false}
		}
	}
	const lookupMany = async<T>(scope: Scope, keys: readonly string[], override?: CacheGetOptions, allowStale = false) => {
		const resolved = resolve(scope, override)
		const originalByResolved = new Map(keys.map((key) => [resolveKey(key, resolved), key]))
		let stored: ReadonlyMap<string, Stored>
		try {
			const resolvedKeys = [...originalByResolved.keys()]
			stored = await runBackend('getMany', async() => {
				await mutationCoordinator.wait(resolvedKeys)
				return await backend.getMany(resolvedKeys, {
					namespace: resolved.namespace,
					version: resolved.version,
					allowStale
				})
			}, false)
		} catch(error) {
			reportError(error, 'get-many', diagnosticScope(resolved.namespace))
			throw error
		}
		const storedEntries = snapshotCacheMap<string, unknown>(stored)
		if (!storedEntries || storedEntries.size > originalByResolved.size
			|| [...storedEntries.keys()].some((key) => typeof key !== 'string' || !originalByResolved.has(key))) {
			reportError(new Error('Cache backend returned an invalid batch result'), 'invalid-result-many')
			throw new Error('Cache backend returned an invalid getMany result')
		}
		const result = new Map<string, Lookup<T>>()
		const corruptKeys: string[] = []
		let invalidEntryCount = 0
		let expiredEntryCount = 0
		let invalidNegativeEntryCount = 0
		let decodeFailureCount = 0
		let responseBytes = 0
		for (const [fullKey, candidate] of storedEntries) {
			const key = originalByResolved.get(fullKey)!
			const entry = projectCacheStoredEntry(candidate)
			if (!entry || entry.metadata.key !== key
				|| entry.metadata.namespace !== resolved.namespace
				|| entry.metadata.version !== resolved.version) {
				corruptKeys.push(fullKey)
				invalidEntryCount++
				continue
			}
			responseBytes = addCacheBatchBytes(responseBytes, entry.value.byteLength, 'Cache getMany')
			const now = readCacheTimestamp(clock)
			if (entry.metadata.expiresAt !== undefined && entry.metadata.expiresAt <= now) {
				corruptKeys.push(fullKey)
				expiredEntryCount++
				continue
			}
			const stale = entry.metadata.staleAt !== undefined && entry.metadata.staleAt <= now
			if (entry.metadata.negative && !isEncodedNegativeCacheValue(entry.value)) {
				corruptKeys.push(fullKey)
				invalidNegativeEntryCount++
				continue
			}
			if (entry.metadata.negative) {
				metric(stale ? 'cache_stale_hit_total' : 'cache_hit_total')
				metric('cache_negative_hit_total')
				metric('cache_lookups_total', 1, {outcome: 'hit', freshness: stale ? 'stale' : 'fresh', kind: 'negative', reason: 'none'})
				result.set(key, {hit: true, stale, negative: true, stored: entry})
				continue
			}
			try {
				const value = decodeCacheValue<T>(entry.value)
				metric(stale ? 'cache_stale_hit_total' : 'cache_hit_total')
				metric('cache_lookups_total', 1, {outcome: 'hit', freshness: stale ? 'stale' : 'fresh', kind: 'positive', reason: 'none'})
				result.set(key, {hit: true, stale, negative: false, value, stored: entry})
			} catch(error) {
				reportError(error, 'decode-many', diagnosticScope(resolved.namespace))
				corruptKeys.push(fullKey)
				decodeFailureCount++
			}
		}
		if (corruptKeys.length > 0) {
			reportError(new Error('Cache backend returned invalid batch entries'), 'invalid-entry-many')
		}
		for (const key of keys) {
			if (!result.has(key)) {
				metric('cache_miss_total')
				metric('cache_lookups_total', 1, {outcome: 'miss', freshness: 'none', kind: 'none', reason: 'batch-missing'})
				result.set(key, {hit: false, stale: false, negative: false})
			}
		}
		if (invalidEntryCount > 0) {
			metric('cache_corrupt_entries_total', invalidEntryCount, {operation: 'get-many', reason: 'invalid-entry'})
		}
		if (invalidNegativeEntryCount > 0) {
			metric('cache_corrupt_entries_total', invalidNegativeEntryCount, {
				operation: 'get-many', reason: 'invalid-negative-entry'
			})
		}
		if (decodeFailureCount > 0) {
			metric('cache_corrupt_entries_total', decodeFailureCount, {operation: 'get-many', reason: 'decode-failure'})
		}
		if (expiredEntryCount > 0) metric('cache_expired_entries_total', expiredEntryCount, {operation: 'get-many'})
		if (corruptKeys.length === 0) markBackendSuccess()
		return result
	}
	const setValue = async<T>(scope: Scope, key: string, value: T, override?: CacheSetOptions, negative = false): Promise<void> => {
		const resolved = resolve(scope, override)
		const fullKey = resolveKey(key, resolved)
		const encoded = encodeCacheValue(negative ? null : value)
		const metadata = createMetadata(key, fullKey, resolved, encoded, negative)
		try {
			// Reserve the key before starting I/O. Marking only after success lets a
			// concurrent cache-aside loader observe the old revision and overwrite a
			// newer explicit write while both backend operations are in flight.
			markMutation([fullKey])
			await runBackend('set', () => mutationCoordinator.run(
				[fullKey],
				() => backend.set(fullKey, encoded, metadata)
			))
		} catch(error) {
			reportError(error, 'set', diagnosticScope(resolved.namespace))
			throw error
		}
		metric('cache_write_total')
		measurement('cache_write_size_bytes', encoded.byteLength, {kind: negative ? 'negative' : 'positive', mode: 'single'})
	}
	const prepareValue = <T>(scope: Scope, key: string, value: T, override?: CacheSetOptions, negative = false) => {
		const resolved = resolve(scope, override)
		const fullKey = resolveKey(key, resolved)
		const encoded = encodeCacheValue(negative ? null : value)
		return {key: fullKey, value: encoded, metadata: createMetadata(key, fullKey, resolved, encoded, negative)}
	}
	const root = createScopedCachePort({
		backend,
		tracker,
		finalization,
		resolve,
		resolveKey,
		lookup,
		lookupMany,
		setValue,
		prepareValue,
		canServeStale(found): boolean {
			if (!found.hit || !found.stale || found.negative || !found.stored) return false
			try {
				return found.stored.metadata.expiresAt === undefined
					|| found.stored.metadata.expiresAt > readCacheTimestamp(clock)
			} catch { return false }
		},
		getMutationRevision,
		markMutation,
		runMutation: mutationCoordinator.run,
		isMutationPending: mutationCoordinator.isPending,
		runBackend,
		markBackendSuccess,
		reportError,
		metric,
		measurement,
		diagnosticScope,
		beginOperation
	}, {namespace: defaultNamespace}, true)
	registerCacheTelemetryTarget(root, observability.controller)
	let flushDisposer: void | (() => void) = undefined
	let shutdownDisposer: void | (() => void) = undefined
	let lifecycleFlushTarget: (() => Promise<void>) | undefined
	let lifecycleShutdownTarget: (() => Promise<void>) | undefined
	try {
		flushDisposer = registerFlushHook?.('cache', async() => {
			const target = lifecycleFlushTarget
			if (target) await target()
		})
		if (flushDisposer !== undefined && typeof flushDisposer !== 'function') {
			throw new Error('Cache lifecycle flush hook returned an invalid disposer')
		}
		shutdownDisposer = registerShutdownHook?.(
			'cache',
			async() => {
				const target = lifecycleShutdownTarget
				if (target) await target()
			},
			{name: 'cache-shutdown'}
		)
		if (shutdownDisposer !== undefined && typeof shutdownDisposer !== 'function') {
			throw new Error('Cache lifecycle shutdown hook returned an invalid disposer')
		}
		lifecycleFlushTarget = root.flush
		lifecycleShutdownTarget = root.shutdown
		finalization.setLifecycleDisposers([() => {
			lifecycleFlushTarget = undefined
			lifecycleShutdownTarget = undefined
			flushDisposer?.()
			shutdownDisposer?.()
		}])
	} catch(error) {
		lifecycleFlushTarget = undefined
		lifecycleShutdownTarget = undefined
		try { flushDisposer?.() } catch(cleanupError) { reportError(cleanupError, 'registration-unregister') }
		try { shutdownDisposer?.() } catch(cleanupError) { reportError(cleanupError, 'registration-unregister') }
		void Promise.resolve().then(() => backend.shutdown?.())
			.catch((cleanupError) => reportError(cleanupError, 'registration-cleanup'))
		throw error
	}
	return root
}
