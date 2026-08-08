import {AsyncLocalStorage} from 'node:async_hooks'

import type {CacheStatus} from '@ooopsstudio/core/contracts/cache'
import type {CacheBackendPort} from '@ooopsstudio/core/ports/cache'

import {
	CACHE_FLUSH_TIMEOUT_MS,
	CACHE_SHUTDOWN_TIMEOUT_MS,
	isCacheTimeoutError,
	MAX_PENDING_CACHE_FLUSH_REQUESTS,
	withCacheTimeout
} from './runtime-safety'
import type {CacheRuntimeTracker} from './runtime-tracking'

type ReportError = (error: unknown, operation: string) => void

export function createCacheFinalization(options: {
	backend: CacheBackendPort
	tracker: CacheRuntimeTracker
	trackBackendOperation<T>(operation: Promise<T>): Promise<T>
	assertBackendOperationCapacity(): void
	waitForBackendOperations(): Promise<void>
	reportError: ReportError
	markBackendSuccess(): void
	markBackendTimeout(): void
	markBackendSettlement(successful: boolean): void
	markFinalizationSuccess(): void
	recover(): void
	snapshot(state: 'running' | 'draining' | 'closed', activeOperations: number): CacheStatus
	getMutationRevision(): number
}) {
	const backendFinalizationCall = new AsyncLocalStorage<boolean>()
	let flushWork: Promise<void> | undefined
	let lastFlushedMutationRevision = -1
	const pendingFlushRequests = new Set<Promise<void>>()
	let shutdownWork: Promise<void> | undefined
	let shutdownAttempt: Promise<void> | undefined
	let backendClosed = false
	let lifecycleDisposed = false
	let lifecycleDisposers: readonly (() => void)[] = []
	const timedOutPhysicalWork = new Set<Promise<unknown>>()

	const assertNotBackendFinalizationReentry = (): void => {
		if (backendFinalizationCall.getStore()) throw new Error('CACHE_FINALIZATION_REENTRY')
	}

	const trackTimeout = (operation: Promise<unknown>): void => {
		if (timedOutPhysicalWork.has(operation)) return
		timedOutPhysicalWork.add(operation)
		options.markBackendTimeout()
		void operation.then(
			() => options.markBackendSettlement(true),
			() => options.markBackendSettlement(false)
		).finally(() => timedOutPhysicalWork.delete(operation))
	}

	const disposeLifecycle = (): void => {
		if (lifecycleDisposed) return
		lifecycleDisposed = true
		for (const disposer of lifecycleDisposers) {
			try { disposer() } catch(error) { options.reportError(error, 'lifecycle-cleanup') }
		}
		lifecycleDisposers = []
	}

	const executeBackendFlush = (revision: number): Promise<void> => {
		if (flushWork) return flushWork
		try { options.assertBackendOperationCapacity() } catch(error) { return Promise.reject(error) }
		const raw = options.trackBackendOperation(Promise.resolve().then(
			() => backendFinalizationCall.run(true, () => options.backend.flush?.())
		))
		flushWork = raw.then(() => {
			lastFlushedMutationRevision = Math.max(lastFlushedMutationRevision, revision)
			options.markFinalizationSuccess()
		}, (error: unknown) => {
			options.reportError(error, 'flush')
			throw error
		}).finally(() => { flushWork = undefined })
		return flushWork
	}

	const waitForFlush = async(raw: Promise<void>): Promise<void> => {
		try {
			await withCacheTimeout(raw, CACHE_FLUSH_TIMEOUT_MS, `Cache flush timed out after ${CACHE_FLUSH_TIMEOUT_MS}ms`)
		} catch(error) {
			if (isCacheTimeoutError(error)) {
				trackTimeout(raw)
			}
			options.reportError(error, 'flush')
			throw error
		}
	}

	const flush = async(): Promise<void> => {
		assertNotBackendFinalizationReentry()
		if (options.tracker.isClosed()) return
		if (!options.tracker.isActive()) return await shutdown()
		if (pendingFlushRequests.size >= MAX_PENDING_CACHE_FLUSH_REQUESTS) {
			throw new Error('Cache pending flush capacity exceeded')
		}
		const activeBarrier = options.tracker.waitForActiveOperations()
		const request = Promise.resolve().then(async() => {
			await activeBarrier
			const revision = options.getMutationRevision()
			await options.waitForBackendOperations()
			if (lastFlushedMutationRevision < revision) await executeBackendFlush(revision)
		})
		pendingFlushRequests.add(request)
		void request.then(
			() => pendingFlushRequests.delete(request),
			() => pendingFlushRequests.delete(request)
		)
		await waitForFlush(request)
	}

	const createShutdownWork = (): Promise<void> => {
		const drain = options.tracker.beginShutdown()
		const physical = Promise.resolve().then(async() => {
			await drain
			await Promise.allSettled([...pendingFlushRequests])
			await options.waitForBackendOperations()
			const revision = options.getMutationRevision()
			if (lastFlushedMutationRevision < revision) await executeBackendFlush(revision)
			if (!backendClosed) {
				try {
					await backendFinalizationCall.run(true, () => options.backend.shutdown?.())
					backendClosed = true
					options.markBackendSuccess()
				} catch(error) {
					options.reportError(error, 'shutdown')
					throw error
				}
			}
			disposeLifecycle()
			options.tracker.close()
			options.recover()
		})
		shutdownWork = physical
		void physical.catch(() => {
			if (shutdownWork === physical) shutdownWork = undefined
		})
		return physical
	}

	const shutdown = async(): Promise<void> => {
		assertNotBackendFinalizationReentry()
		if (options.tracker.isClosed()) return
		if (shutdownAttempt) return shutdownAttempt
		const physical = shutdownWork ?? createShutdownWork()
		shutdownAttempt = withCacheTimeout(
			physical,
			CACHE_SHUTDOWN_TIMEOUT_MS,
			`Cache shutdown timed out after ${CACHE_SHUTDOWN_TIMEOUT_MS}ms`
		).catch((error) => {
			if (isCacheTimeoutError(error)) {
				trackTimeout(physical)
			}
			options.reportError(error, 'shutdown')
			throw error
		}).finally(() => { shutdownAttempt = undefined })
		return shutdownAttempt
	}

	return {
		setLifecycleDisposers(disposers: readonly (() => void)[]): void {
			lifecycleDisposers = Object.freeze([...disposers])
		},
		getStatus(): CacheStatus {
			return options.snapshot(options.tracker.getState(), options.tracker.getActiveOperations())
		},
		flush,
		shutdown
	}
}
