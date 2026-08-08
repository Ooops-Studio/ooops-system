import {AsyncLocalStorage} from 'node:async_hooks'

import type {AuditPage, AuditQuery, AuditRecord, AuditWriteRequest} from '@ooopsstudio/core/contracts/audit'
import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {
	AuditAdminPort,
	AuditRuntime,
	AuditStatus,
	ManagedAudit,
	TransactionalAuditPort
} from '@ooopsstudio/core/ports/audit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {
	AUDIT_MAX_ACTIVE_OPERATIONS,
	AUDIT_MAX_PENDING_FLUSH_ATTEMPTS,
	AUDIT_MAX_PENDING_SHUTDOWN_ATTEMPTS
} from '../constants'
import {emitAuditTelemetry, registerAuditTelemetryTarget} from '../runtime-capabilities'
import type {
	AuditAdminStore,
	AuditPrunePlan,
	AuditRedactionRule,
	AuditSafetyLimits,
	AuditStore,
	TransactionalAuditStore
} from '../types/store'
import {captureAuditCapability, captureAuditClock} from '../utils/capabilities'
import {isAuditSafeString} from '../utils/string-safety'

import {
	assertPreparedAuditRecordSafe,
	normalizeAuditQuery,
	validateAppendResults,
	validateAuditPage,
	validateAuditRecord
} from './handler-support'
import {createLazyAuditAdmin} from './lazy-admin'
import {withAuditTimeout} from './operation-support'
import {normalizeAuditWriteRequest} from './write-normalization'

export interface AuditRuntimeOptions {
	readonly clock: Clock
	readonly store: AuditStore
	readonly transactionalStore?: TransactionalAuditStore
	readonly adminStore?: AuditAdminStore
	readonly adminLifecycle?: {flush?(): Promise<void>; shutdown?(): Promise<void>}
	readonly lifecycle?: LifecyclePort
	readonly resource?: ObservabilityResource
	readonly redactionRules: readonly AuditRedactionRule[]
	readonly limits: AuditSafetyLimits
	readonly flushTimeoutMs: number
	readonly shutdownTimeoutMs: number
	readonly archivePlan?: (plan: AuditPrunePlan) => Promise<number>
	readonly archiveLifecycle?: {flush?(): Promise<void>; shutdown?(): Promise<void>}
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
	for (const nested of Object.values(value)) deepFreeze(nested)
	return Object.freeze(value)
}

function snapshotWriteBatch(value: readonly AuditWriteRequest[], maximum: number): readonly AuditWriteRequest[] {
	if (!Array.isArray(value)) throw new Error(`Audit batch must contain between 1 and ${maximum} records.`)
	try {
		const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
		if (!Number.isSafeInteger(length) || length < 1 || length > maximum) throw new Error()
		const allowed = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error()
		return Object.freeze(Array.from({length}, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			return descriptor.value as AuditWriteRequest
		}))
	} catch { throw new Error(`Audit batch must contain between 1 and ${maximum} readable records.`) }
}

function captureStore(source: AuditStore): AuditStore {
	if (!source || typeof source !== 'object') throw new Error('Audit runtime requires a store.')
	const appendMany = captureAuditCapability<Parameters<AuditStore['appendMany']>, ReturnType<AuditStore['appendMany']>>(source, 'appendMany')
	const getById = captureAuditCapability<Parameters<AuditStore['getById']>, ReturnType<AuditStore['getById']>>(source, 'getById')
	const query = captureAuditCapability<Parameters<AuditStore['query']>, ReturnType<AuditStore['query']>>(source, 'query')
	const flush = captureAuditCapability<[], Promise<void>>(source, 'flush')
	const shutdown = captureAuditCapability<[], Promise<void>>(source, 'shutdown')
	if (!appendMany || !getById || !query) throw new Error('Audit runtime requires a complete store.')
	return Object.freeze({kind: 'captured', appendMany, getById, query, ...(flush ? {flush} : {}), ...(shutdown ? {shutdown} : {})})
}

function captureTransactionalStore(source: TransactionalAuditStore | undefined): TransactionalAuditStore | undefined {
	const appendTransactional = captureAuditCapability<
		Parameters<TransactionalAuditStore['appendTransactional']>,
		ReturnType<TransactionalAuditStore['appendTransactional']>
	>(source, 'appendTransactional')
	return appendTransactional ? Object.freeze({appendTransactional}) : undefined
}

function captureAdminStore(source: AuditAdminStore | undefined): AuditAdminStore | undefined {
	if (source === undefined) return undefined
	const verifyIntegrity = captureAuditCapability<Parameters<AuditAdminStore['verifyIntegrity']>, ReturnType<AuditAdminStore['verifyIntegrity']>>(source, 'verifyIntegrity')
	const planPruneBefore = captureAuditCapability<Parameters<AuditAdminStore['planPruneBefore']>, ReturnType<AuditAdminStore['planPruneBefore']>>(source, 'planPruneBefore')
	const prunePlanned = captureAuditCapability<Parameters<AuditAdminStore['prunePlanned']>, ReturnType<AuditAdminStore['prunePlanned']>>(source, 'prunePlanned')
	if (!verifyIntegrity || !planPruneBefore || !prunePlanned) throw new Error('Audit admin store must provide all admin capabilities.')
	return Object.freeze({verifyIntegrity, planPruneBefore, prunePlanned})
}

function failureCode(error: unknown, fallback: string): string {
	if (error && typeof error === 'object') {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
			if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
				&& /^[A-Z][A-Z0-9_]{2,63}$/.test(descriptor.value)) return descriptor.value
		} catch { /* fixed fallback */ }
	}
	return fallback
}

function deterministicFailure(error: unknown): boolean {
	let message = ''
	try { if (error instanceof Error) message = error.message } catch { /* fixed classification */ }
	return /invalid|must |requires|does not support|idempotency|already exists|pruned record|partition was pruned|capacity exhausted/i.test(message)
}

export function createAuditRuntime(options: AuditRuntimeOptions): AuditRuntime {
	const finalizationContext = new AsyncLocalStorage<boolean>()
	const clock = captureAuditClock(options.clock)
	const store = captureStore(options.store)
	const transactionalStore = captureTransactionalStore(options.transactionalStore)
	const adminStore = captureAdminStore(options.adminStore)
	const registerShutdownHook = captureAuditCapability<
		Parameters<NonNullable<LifecyclePort['registerShutdownHook']>>,
		ReturnType<NonNullable<LifecyclePort['registerShutdownHook']>>
	>(options.lifecycle, 'registerShutdownHook')
	const registerFlushHook = captureAuditCapability<
		Parameters<NonNullable<LifecyclePort['registerFlushHook']>>,
		ReturnType<NonNullable<LifecyclePort['registerFlushHook']>>
	>(options.lifecycle, 'registerFlushHook')

	let state: AuditStatus['state'] = 'running'
	let lastFailureCode: string | undefined
	const active = new Set<Promise<void>>()
	const disposers: Array<() => void> = []
	let flushCompleted = false
	let mutationVersion = 0
	let flushPhysical: Promise<void> | undefined
	let pendingFlushAttempts = 0
	let pendingShutdownAttempts = 0
	let storeClosed = false
	let storeClosePhysical: Promise<void> | undefined
	let archiveClosed = false
	let archiveClosePhysical: Promise<void> | undefined
	let adminClosed = false
	let adminClosePhysical: Promise<void> | undefined
	let hooksDisposed = false
	let shutdownPipeline: Promise<void> | undefined
	let shutdownAttempt: Promise<void> | undefined
	let audit!: ManagedAudit

	const emit = (event: Parameters<typeof emitAuditTelemetry>[1]) => finalizationContext.run(
		true,
		() => emitAuditTelemetry(audit, event)
	)
	const setFailure = (code: string) => { lastFailureCode = code }
	const clearFailure = () => {
		if (lastFailureCode) emit({kind: 'recovered'})
		lastFailureCode = undefined
	}
	const ensureNotFinalizing = () => {
		if (finalizationContext.getStore()) throw new Error('AUDIT_FINALIZATION_REENTRY')
	}
	const ensureRunning = () => {
		ensureNotFinalizing()
		if (state !== 'running') throw new Error('Audit service is draining or closed.')
		if (active.size >= AUDIT_MAX_ACTIVE_OPERATIONS) throw new Error('AUDIT_OPERATION_CAPACITY')
	}
	const markDirty = () => {
		mutationVersion += 1
		flushCompleted = false
	}
	const track = async<T>(operation: () => Promise<T>): Promise<T> => {
		ensureRunning()
		let release!: () => void
		const marker = new Promise<void>((resolve) => { release = resolve })
		active.add(marker)
		emit({kind: 'active', count: active.size})
		try { return await finalizationContext.run(true, operation) }
		finally {
			active.delete(marker)
			release()
			emit({kind: 'active', count: active.size})
		}
	}
	const reportOperationFailure = (
		operation: 'record' | 'query' | 'transaction' | 'export' | 'verify' | 'prune',
		error: unknown,
		fallback = 'AUDIT_STORE_FAILURE'
	) => {
		const code = failureCode(error, fallback)
		setFailure(code)
		emit({kind: 'operation_failed', operation, code, reportable: !deterministicFailure(error)})
	}
	const prepare = (requests: readonly AuditWriteRequest[]) => {
		ensureRunning()
		return finalizationContext.run(true, () => {
			const prepared = []
			let bytes = 2
			for (const request of snapshotWriteBatch(requests, options.limits.maxBatchRecords)) {
				const record = normalizeAuditWriteRequest(clock, request, options.redactionRules, options.limits, options.resource, false)
				bytes += Buffer.byteLength(JSON.stringify(record)) + (prepared.length ? 1 : 0)
				if (bytes > options.limits.maxBatchBytes) throw new Error(`Audit batch exceeds the maximum of ${options.limits.maxBatchBytes} bytes.`)
				assertPreparedAuditRecordSafe(record, options.limits, options.redactionRules)
				prepared.push(deepFreeze(record))
			}
			return Object.freeze(prepared)
		})
	}
	const runWrite = async(
		prepared: ReturnType<typeof prepare>,
		transaction?: unknown
	): Promise<readonly AuditRecord[]> => {
		// Treat admission to a mutating store call as dirty. A store may persist the
		// batch and still reject (for example, when its response is lost), so marking
		// only validated successes could incorrectly make the next flush a no-op.
		markDirty()
		try {
			const raw = transaction === undefined
				? await store.appendMany(prepared)
				: await transactionalStore!.appendTransactional(transaction, prepared)
			const validationTime = Math.max(...prepared.map((record) => Date.parse(record.createdAt)))
			const results = validateAppendResults(prepared, raw, options.limits, options.redactionRules, validationTime)
			const inserted = results.filter((entry) => entry.inserted).length
			clearFailure()
			emit({kind: 'recorded', count: inserted})
			return deepFreeze(results.map((entry) => entry.record))
		} catch(error) {
			reportOperationFailure(transaction === undefined ? 'record' : 'transaction', error)
			throw error
		}
	}

	const ensureFlushPhysical = (): Promise<void> => {
		if (flushCompleted) return Promise.resolve()
		if (flushPhysical) return flushPhysical
		const targetMutationVersion = mutationVersion
		const physical = (async() => {
			await Promise.allSettled([...active])
			await finalizationContext.run(true, () => store.flush?.())
			await finalizationContext.run(true, () => options.adminLifecycle?.flush?.())
			await finalizationContext.run(true, () => options.archiveLifecycle?.flush?.())
		})()
		flushPhysical = physical
		void physical.then(
			() => {
				flushCompleted = mutationVersion === targetMutationVersion
				if (flushPhysical === physical) flushPhysical = undefined
			},
			() => { if (flushPhysical === physical) flushPhysical = undefined }
		)
		return physical
	}
	const ensureShutdownFlushed = async(): Promise<void> => {
		// Admission is closed before the shutdown pipeline starts, so this loop is
		// finite. A pre-existing flush can finish stale when a write was admitted
		// after that flush captured its mutation version but before shutdown.
		do { await ensureFlushPhysical() } while (!flushCompleted)
	}
	const ensureStoreClosed = (): Promise<void> => {
		if (storeClosed) return Promise.resolve()
		if (storeClosePhysical) return storeClosePhysical
		const physical = Promise.resolve().then(
			() => finalizationContext.run(true, () => store.shutdown?.())
		).then(() => { storeClosed = true })
		storeClosePhysical = physical
		void physical.finally(() => { if (storeClosePhysical === physical) storeClosePhysical = undefined }).catch(() => undefined)
		return physical
	}
	const ensureArchiveClosed = (): Promise<void> => {
		if (archiveClosed) return Promise.resolve()
		if (archiveClosePhysical) return archiveClosePhysical
		const physical = Promise.resolve().then(
			() => finalizationContext.run(true, () => options.archiveLifecycle?.shutdown?.())
		).then(() => { archiveClosed = true })
		archiveClosePhysical = physical
		void physical.finally(() => { if (archiveClosePhysical === physical) archiveClosePhysical = undefined }).catch(() => undefined)
		return physical
	}
	const ensureAdminClosed = (): Promise<void> => {
		if (adminClosed) return Promise.resolve()
		if (adminClosePhysical) return adminClosePhysical
		const physical = Promise.resolve().then(
			() => finalizationContext.run(true, () => options.adminLifecycle?.shutdown?.())
		).then(() => { adminClosed = true })
		adminClosePhysical = physical
		void physical.finally(() => { if (adminClosePhysical === physical) adminClosePhysical = undefined }).catch(() => undefined)
		return physical
	}
	const disposeHooks = () => {
		if (hooksDisposed) return
		for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* isolated */ } }
		hooksDisposed = true
	}
	const getShutdownPipeline = (): Promise<void> => {
		if (shutdownPipeline) return shutdownPipeline
		const pipeline = (async() => {
			await Promise.allSettled([...active])
			await ensureShutdownFlushed()
			await ensureArchiveClosed()
			await ensureAdminClosed()
			await ensureStoreClosed()
			disposeHooks()
		})()
		shutdownPipeline = pipeline
		void pipeline.catch(() => { if (shutdownPipeline === pipeline) shutdownPipeline = undefined })
		return pipeline
	}

	audit = Object.freeze({
		async record(request: AuditWriteRequest): Promise<AuditRecord> {
			const prepared = prepare([request])
			return await track(async() => (await runWrite(prepared))[0]!)
		},
		async recordMany(requests: readonly AuditWriteRequest[]): Promise<readonly AuditRecord[]> {
			const prepared = prepare(requests)
			return await track(async() => await runWrite(prepared))
		},
		async getById(id: string): Promise<AuditRecord | undefined> {
			if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 512 || !isAuditSafeString(id)) throw new Error('Audit id is invalid.')
			return await track(async() => {
				try {
					const raw = await store.getById(id)
					if (raw === undefined) return undefined
					const record = validateAuditRecord(raw, options.limits, options.redactionRules, clock.now())
					if (record.id !== id) throw new Error('Audit store returned a record for a different id.')
					clearFailure()
					return deepFreeze(record)
				} catch(error) { reportOperationFailure('query', error); throw error }
			})
		},
		async query(query: AuditQuery): Promise<AuditPage> {
			ensureRunning()
			const snapshot = finalizationContext.run(true, () => normalizeAuditQuery(query))
			return await track(async() => {
				try {
					const result = validateAuditPage(
						await store.query(snapshot), snapshot.limit ?? 100, snapshot, options.limits, options.redactionRules, clock.now()
					)
					clearFailure()
					return deepFreeze(result)
				} catch(error) { reportOperationFailure('query', error); throw error }
			})
		},
		getStatus(): AuditStatus {
			try {
				return Object.freeze({state, activeOperations: active.size, ...(lastFailureCode ? {lastFailureCode} : {})})
			} catch { return Object.freeze({state, activeOperations: 0, lastFailureCode: 'AUDIT_STATUS_FAILURE'}) }
		},
		async flush(): Promise<void> {
			ensureNotFinalizing()
			if (state === 'closed') return
			if (pendingFlushAttempts >= AUDIT_MAX_PENDING_FLUSH_ATTEMPTS) throw new Error('AUDIT_FLUSH_CAPACITY')
			pendingFlushAttempts += 1
			try {
				const operation = state === 'draining'
					? shutdownAttempt ?? getShutdownPipeline()
					: ensureFlushPhysical()
				await withAuditTimeout(operation, options.flushTimeoutMs, 'flush')
				clearFailure()
			} catch(error) {
				const code = failureCode(error, 'AUDIT_FLUSH_TIMEOUT')
				setFailure(code)
				emit({kind: 'finalization_failed', operation: 'flush', code})
				throw error
			} finally { pendingFlushAttempts -= 1 }
		},
		async shutdown(): Promise<void> {
			ensureNotFinalizing()
			if (state === 'closed') return
			if (pendingShutdownAttempts >= AUDIT_MAX_PENDING_SHUTDOWN_ATTEMPTS) throw new Error('AUDIT_SHUTDOWN_CAPACITY')
			pendingShutdownAttempts += 1
			try {
				if (shutdownAttempt) return await shutdownAttempt
				state = 'draining'
				const attempt = (async() => {
					try {
						await withAuditTimeout(getShutdownPipeline(), options.shutdownTimeoutMs, 'shutdown')
						state = 'closed'
						clearFailure()
					} catch(error) {
						const code = failureCode(error, 'AUDIT_SHUTDOWN_TIMEOUT')
						setFailure(code)
						emit({kind: 'finalization_failed', operation: 'shutdown', code})
						throw error
					}
				})()
				shutdownAttempt = attempt
				try { await attempt } finally { if (shutdownAttempt === attempt) shutdownAttempt = undefined }
			} finally { pendingShutdownAttempts -= 1 }
		}
	}) satisfies ManagedAudit
	registerAuditTelemetryTarget(audit)

	const transactional: TransactionalAuditPort | undefined = transactionalStore
		? Object.freeze({
			async recordTransactional(transaction: unknown, requests: readonly AuditWriteRequest[]) {
				if (transaction === undefined || transaction === null) throw new Error('Audit transaction is invalid.')
				const prepared = prepare(requests)
				return await track(async() => await runWrite(prepared, transaction))
			}
		})
		: undefined

	let admin: AuditAdminPort | undefined
	if (adminStore) {
		const combined = Object.freeze({...store, ...adminStore}) as AuditStore & AuditAdminStore
		const implementation = createLazyAuditAdmin({
			store: combined,
			now: clock.now,
			limits: options.limits,
			redactionRules: options.redactionRules,
			...(options.archivePlan ? {archivePlan: options.archivePlan} : {}),
			track,
			markDirty,
			observeFailure: async(operation, error) => {
				const mapped = operation === 'verify_integrity' ? 'verify' : operation === 'prune_before' ? 'prune' : 'export'
				reportOperationFailure(mapped, error, mapped === 'verify' ? 'AUDIT_INTEGRITY_FAILURE' : mapped === 'prune' ? 'AUDIT_PRUNE_FAILURE' : 'AUDIT_EXPORT_FAILURE')
			}
		})
		admin = Object.freeze({
			async export(request: Parameters<AuditAdminPort['export']>[0]) { return deepFreeze(await implementation.export(request)) },
			async verifyIntegrity(filter: Parameters<AuditAdminPort['verifyIntegrity']>[0]) {
				const result = deepFreeze(await implementation.verifyIntegrity(filter))
				if (!result.ok) emit({kind: 'integrity_failed'})
				return result
			},
			async pruneBefore(
				cutoff: Parameters<AuditAdminPort['pruneBefore']>[0],
				options?: Parameters<AuditAdminPort['pruneBefore']>[1]
			) {
				const result = deepFreeze(await implementation.pruneBefore(cutoff, options))
				if (result.deletedCount > 0) emit({kind: 'pruned', count: result.deletedCount})
				return result
			}
		})
	}

	try {
		const shutdownDisposer = registerShutdownHook?.('observability', async() => await audit.shutdown(), {name: 'audit-shutdown', priority: 10})
		if (typeof shutdownDisposer === 'function') disposers.push(shutdownDisposer)
		const flushDisposer = registerFlushHook?.('audit', async() => await audit.flush())
		if (typeof flushDisposer === 'function') disposers.push(flushDisposer)
	} catch(error) {
		disposeHooks()
		throw error
	}

	return Object.freeze({audit, ...(transactional ? {transactional} : {}), ...(admin ? {admin} : {})})
}
