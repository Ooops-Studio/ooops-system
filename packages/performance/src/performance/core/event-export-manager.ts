import type {PerformanceEventRecord} from '@ooopsstudio/core/contracts/performance'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {PerformanceEventExporterPort} from '@ooopsstudio/core/ports/performance'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'

import type {PerformanceSinkState} from '../types/ports'
import {ignoreRuntimePromiseRejection, isRuntimePromise, isRuntimeProxy} from '../utils/safe-object'

import {createEventExporterLifecycleOperations} from './event-export-lifecycle'
import {
	MAX_PERFORMANCE_EXPORT_BATCH_BYTES,
	MAX_PERFORMANCE_EXPORT_BATCH_COUNT,
	MAX_PERFORMANCE_TIMER_MS,
	serializePerformanceEventRecord,
	sleep,
	withPerformanceExportTimeout
} from './event-export-utils'
import {createPerformanceExportError, getPerformanceExportErrorMetadata} from './export-errors'
import {deepFreezePerformanceValue} from './utils/event-helpers'

const MAX_EXPORT_OPERATION_TIMEOUT_MS = 5_000
const MAX_EXPORT_RETRY_DELAY_MS = 5_000
const MAX_EXPORT_DELIVERY_BUDGET_MS = 30_000
const KNOWN_EXPORT_FAILURE_CODE = /^(?:performance_export_timeout|http_(?:rate_limited|server_error|client_error|unexpected_status)|fetch_(?:aborted|failed)|invalid_fetch_response|event_serialization_failed)$/
const DROPPED_TOTAL_METRIC = '_performance_dropped_total'
const QUEUE_SIZE_METRIC = '_performance_export_queue_size'

type ExporterMethod = 'export' | 'flush' | 'shutdown'

const captureExporterMethod = (
	target: unknown,
	key: ExporterMethod
): ((...args: never[]) => unknown) | undefined => {
	if (isRuntimeProxy(target) || (typeof target !== 'object' && typeof target !== 'function') || target === null) return undefined
	try {
		let owner: object | null = target
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...args: never[]) => unknown
				return (...args: never[]) => {
					const result = Reflect.apply(method, target, args)
					if (result !== undefined && !isRuntimePromise(result)) throw createPerformanceExportError('', {
						retryable: false, code: 'invalid_exporter_result'
					})
					return result
				}
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

const hasExporterProperty = (target: unknown, key: ExporterMethod): boolean => {
	if (isRuntimeProxy(target) || (typeof target !== 'object' && typeof target !== 'function') || target === null) return false
	try {
		let owner: object | null = target
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return true
			if (Object.getOwnPropertyDescriptor(owner, key)) return true
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return true }
	return false
}

const captureErrorsReport = (errors: unknown): ((...args: unknown[]) => unknown) | undefined => {
	if (!errors || (typeof errors !== 'object' && typeof errors !== 'function') || isRuntimeProxy(errors)) return undefined
	try {
		let owner: object | null = errors
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'report')
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const report = descriptor.value as (...args: unknown[]) => unknown
				return (...args: unknown[]) => Reflect.apply(report, errors, args)
			}
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

const captureExporter = (name: string, exporter: unknown): PerformanceEventExporterPort => {
	const exportBatch = captureExporterMethod(exporter, 'export')
	const flush = captureExporterMethod(exporter, 'flush')
	const shutdown = captureExporterMethod(exporter, 'shutdown')
	if (!exportBatch) throw new Error(`Performance event exporter "${name}" must provide a data-method export function`)
	if (hasExporterProperty(exporter, 'flush') && !flush) {
		throw new Error(`Performance event exporter "${name}" flush must be a data-method function`)
	}
	if (hasExporterProperty(exporter, 'shutdown') && !shutdown) {
		throw new Error(`Performance event exporter "${name}" shutdown must be a data-method function`)
	}
	return Object.freeze({
		export: exportBatch as PerformanceEventExporterPort['export'],
		...(flush ? {flush: flush as NonNullable<PerformanceEventExporterPort['flush']>} : {}),
		...(shutdown ? {shutdown: shutdown as NonNullable<PerformanceEventExporterPort['shutdown']>} : {})
	})
}

export interface EventExportManagerOptions {
	exporters: ReadonlyArray<{name: string; exporter: PerformanceEventExporterPort}>
	maxBufferCount: number
	maxBufferBytes: number
	flushIntervalMs: number
	retryAttempts: number
	retryBaseDelayMs: number
	operationTimeoutMs?: number
	errors?: Errors
	observe?: (name: string, value: number, labels?: Record<string, string>) => void
}

export interface EventExportStatus {
	queueSize: number
	droppedTotal: number
	retriedTotal: number
	sinkState: PerformanceSinkState
	lastFailureCode?: string
}

export interface EventExportManager {
	enqueue(record: PerformanceEventRecord): void
	flush(): Promise<void>
	shutdown(): Promise<void>
	getStatus(): EventExportStatus
}

export function createEventExportManager(
	options: EventExportManagerOptions
): EventExportManager {
	if (!options || typeof options !== 'object') {
		throw new Error('Performance event export options must be an object')
	}
	const {
		exporters: configuredExporters,
		maxBufferCount,
		maxBufferBytes,
		flushIntervalMs,
		retryAttempts,
		retryBaseDelayMs,
		operationTimeoutMs = 5_000,
		errors,
		observe
	} = options
	if (isRuntimeProxy(configuredExporters) || !Array.isArray(configuredExporters)) {
		throw new Error('Performance event exporters must be an array')
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(configuredExporters, 'length')
	const configuredExporterCount = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : -1
	if (!Number.isSafeInteger(configuredExporterCount) || configuredExporterCount > 2) {
		throw new Error('Performance event export supports at most two exporters')
	}
	const configuredEntries: Array<{name: string; exporter: unknown}> = []
	for (let index = 0; index < configuredExporterCount; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(configuredExporters, String(index))
		if (!descriptor || !('value' in descriptor)) {
			throw new Error('Performance event exporters must use data properties')
		}
		const configured: unknown = descriptor.value
		if (!configured || typeof configured !== 'object' || isRuntimeProxy(configured)) {
			throw new Error('Performance event exporters must be valid objects')
		}
		let name: unknown
		let exporter: unknown
		try {
			const nameDescriptor = Object.getOwnPropertyDescriptor(configured, 'name')
			const exporterDescriptor = Object.getOwnPropertyDescriptor(configured, 'exporter')
			if (!nameDescriptor || !('value' in nameDescriptor) || !exporterDescriptor || !('value' in exporterDescriptor)) {
				throw new TypeError()
			}
			name = nameDescriptor.value
			exporter = exporterDescriptor.value
		} catch { throw new Error('Performance event exporters must use data properties') }
		configuredEntries.push({name: name as string, exporter})
	}
	if (!Number.isInteger(maxBufferCount) || maxBufferCount <= 0 || maxBufferCount > 100_000) {
		throw new Error('Performance event export maxBufferCount must be between 1 and 100000')
	}
	if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0 || maxBufferBytes > 100 * 1024 * 1024) {
		throw new Error('Performance event export maxBufferBytes must be between 1 and 104857600')
	}
	if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs < 0 || flushIntervalMs > MAX_PERFORMANCE_TIMER_MS) {
		throw new Error(`Performance flushIntervalMs must be between 0 and ${MAX_PERFORMANCE_TIMER_MS}`)
	}
	if (!Number.isInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 10) {
		throw new Error('Performance event export retryAttempts must be between 0 and 10')
	}
	if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > MAX_EXPORT_RETRY_DELAY_MS) {
		throw new Error(`Performance retryBaseDelayMs must be between 0 and ${MAX_EXPORT_RETRY_DELAY_MS}`)
	}
	if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0 || operationTimeoutMs > MAX_EXPORT_OPERATION_TIMEOUT_MS) {
		throw new Error(`Performance operationTimeoutMs must be between 1 and ${MAX_EXPORT_OPERATION_TIMEOUT_MS}`)
	}
	if (operationTimeoutMs * (retryAttempts + 1)
		+ retryBaseDelayMs * ((retryAttempts * (retryAttempts + 1)) / 2)
		> MAX_EXPORT_DELIVERY_BUDGET_MS) {
		throw new Error(`Performance event export retry policy must fit within ${MAX_EXPORT_DELIVERY_BUDGET_MS}ms`)
	}
	const exporterNames = new Set<string>()
	const exporters: Array<{name: string; exporter: PerformanceEventExporterPort}> = []
	for (const configured of configuredEntries) {
		const {name} = configured
		if (typeof name !== 'string' || name.length > 64 ||
			!/^[a-z][a-z0-9_.-]{0,63}$/i.test(name) || exporterNames.has(name)) {
			throw new Error('Performance event exporter names must be unique safe identifiers')
		}
		exporters.push({name, exporter: captureExporter(name, configured.exporter)})
		exporterNames.add(name)
	}
	type QueueItem = {serialized: string; bytes: number; pending: Set<string>; partial: boolean; id: number}
	const logicalQueue: QueueItem[] = []
	let logicalQueueBytes = 0
	let partiallyCommittedRecords = 0
	let nextSequence = 0
	const exporterHealth = new Map<string, {isHealthy: boolean; failures: number}>()
	const terminalExporters = new Set<string>()
	const completedExporterLifecycles = new Set<string>()
	const pendingDeliveries = new Map<string, Promise<void>>()
	const pendingFlushHooks = new Map<string, Promise<void>>()
	const exportersNeedingFlush = new Set<string>()
	const lifecycleOperations = createEventExporterLifecycleOperations()
	for (const {name} of exporters) {
		exporterHealth.set(name, {isHealthy: true, failures: 0})
	}
	let droppedEvents = 0
	let retriedTotal = 0
	let activeRetries = 0
	let lastFailureCode: string | undefined
	let stopped = false
	let closing = false
	let flushPromise: Promise<void> | null = null
	let requestedFlushGeneration = 0
	let completedFlushGeneration = 0
	let requestedExporterHooks = false
	let shutdownPromise: Promise<void> | null = null
	let timer: ReturnType<typeof setInterval> | undefined
	const errorsReport = captureErrorsReport(errors)
	let pendingErrorReport: Promise<unknown> | true | undefined
	let pendingObservation: Promise<unknown> | true | undefined
	const reportError = (context: Record<string, string>): void => {
		if (pendingErrorReport) return
		pendingErrorReport = true
		try {
			const result = errorsReport?.(normalizeError(new Error('performance_export_failed')), context)
			ignoreRuntimePromiseRejection(result)
			if (isRuntimePromise(result)) {
				const reportPromise = result as Promise<unknown>
				pendingErrorReport = reportPromise
				const release = () => { if (pendingErrorReport === reportPromise) pendingErrorReport = undefined }
				void Reflect.apply(Promise.prototype.then, reportPromise, [
					release,
					release
				])
			} else pendingErrorReport = undefined
		} catch {
			// Error reporting must not affect exporter state or create an unhandled rejection.
		}
	}
	const emit = (name: string, value: number, labels?: Record<string, string>) => {
		if (pendingObservation) return
		pendingObservation = true
		try {
			const result: unknown = observe?.(name, value, labels)
			ignoreRuntimePromiseRejection(result)
			if (isRuntimePromise(result)) {
				const observation = result as Promise<unknown>
				pendingObservation = observation
				const release = () => { if (pendingObservation === observation) pendingObservation = undefined }
				try {
					void Reflect.apply(Promise.prototype.then, observation, [release, release])
				} catch { release() }
			} else pendingObservation = undefined
		} catch { /* broken telemetry stays disabled */ }
	}
	const setExporterFailure = (name: string, error: unknown) => {
		const previous = exporterHealth.get(name) ?? {isHealthy: true, failures: 0}
		const safeError = getPerformanceExportErrorMetadata(error)?.code ?? 'performance_export_failed'
		lastFailureCode = KNOWN_EXPORT_FAILURE_CODE.test(safeError)
			? safeError.toUpperCase()
			: 'PERFORMANCE_EXPORT_FAILURE'
		exporterHealth.set(name, {
			isHealthy: false,
			failures: previous.failures + 1
		})
		emit('_performance_export_failures_total', 1)
		reportError({stage: 'performance', operation: 'event_export', exporter: name})
	}
	const setExporterSuccess = (name: string) => {
		const previous = exporterHealth.get(name) ?? {isHealthy: true, failures: 0}
		exporterHealth.set(name, {
			isHealthy: true,
			failures: previous.failures
		})
		if ([...exporterHealth.values()].every(({isHealthy}) => isHealthy)) lastFailureCode = undefined
	}
	const getActiveExporterNames = () =>
		exporters
			.map(({name}) => name)
			.filter((name) => !terminalExporters.has(name))
	const countPending = (name: string, through: number) =>
		logicalQueue.filter((item) => item.id <= through && item.pending.has(name)).length
	const pruneCommitted = (): void => {
		// Every destination consumes records in queue order, so the intersection of
		// their committed prefixes is itself one prefix. Remove it in one splice;
		// per-record splices turn a maximum-size drain into quadratic work.
		let committedCount = 0
		let committedBytes = 0
		while (logicalQueue[committedCount]?.pending.size === 0) {
			committedBytes += logicalQueue[committedCount]!.bytes
			committedCount += 1
		}
		if (committedCount > 0) {
			logicalQueue.splice(0, committedCount)
			logicalQueueBytes -= committedBytes
		}
	}
	const removePendingDestination = (item: QueueItem, name: string): boolean => {
		if (!item.pending.delete(name)) return false
		if (item.pending.size > 0 && !item.partial) {
			item.partial = true
			partiallyCommittedRecords += 1
		} else if (item.pending.size === 0 && item.partial) {
			item.partial = false
			partiallyCommittedRecords -= 1
		}
		return true
	}
	const abandonDestination = (name: string): void => {
		let terminalDrops = 0
		for (const item of logicalQueue) {
			if (removePendingDestination(item, name)) terminalDrops += 1
		}
		pruneCommitted()
		droppedEvents += terminalDrops
		if (terminalDrops > 0) emit(DROPPED_TOTAL_METRIC, terminalDrops, {reason: 'terminal_exporter_error'})
		emit(QUEUE_SIZE_METRIC, logicalQueue.length)
	}
	const terminateDestination = (name: string, error: unknown): void => {
		if (terminalExporters.has(name)) return
		terminalExporters.add(name)
		setExporterFailure(name, error)
		abandonDestination(name)
	}
	const releasePartiallyCommittedRecord = (activeDestinationCount: number): boolean => {
		if (partiallyCommittedRecords === 0 || activeDestinationCount < 2) return false
		const index = logicalQueue.findIndex((item) => item.partial && item.pending.size < activeDestinationCount)
		if (index < 0) return false
		const releasedBytes = logicalQueue[index]!.bytes
		logicalQueue[index]!.partial = false
		partiallyCommittedRecords -= 1
		logicalQueue.splice(index, 1)
		logicalQueueBytes -= releasedBytes
		droppedEvents += 1
		emit(DROPPED_TOTAL_METRIC, 1, {reason: 'partial_fanout_backpressure'})
		emit(QUEUE_SIZE_METRIC, logicalQueue.length)
		return true
	}
	const deliverBatch = (
		name: string,
		exporter: PerformanceEventExporterPort,
		through: number
	): Promise<void> => {
		const existing = pendingDeliveries.get(name)
		if (existing) return existing
		const items: QueueItem[] = []
		let batchBytes = 0
		for (const item of logicalQueue) {
			if (item.id > through) break
			if (!item.pending.has(name)) continue
			if (items.length >= MAX_PERFORMANCE_EXPORT_BATCH_COUNT
				|| batchBytes + item.bytes > MAX_PERFORMANCE_EXPORT_BATCH_BYTES) break
			items.push(item)
			batchBytes += item.bytes
		}
		const attemptBatch = deepFreezePerformanceValue(
			items.map((item) => JSON.parse(item.serialized) as PerformanceEventRecord)
		)
		const operation = Promise.resolve()
			.then(async() => await exporter.export(attemptBatch))
			.then(() => {
				setExporterSuccess(name)
				if (exporter.flush) exportersNeedingFlush.add(name)
				for (const item of items) removePendingDestination(item, name)
				pruneCommitted()
				emit(QUEUE_SIZE_METRIC, logicalQueue.length)
				if (pendingDeliveries.get(name) === operation) pendingDeliveries.delete(name)
			})
		pendingDeliveries.set(name, operation)
		void operation.catch((error) => {
			if (pendingDeliveries.get(name) === operation) pendingDeliveries.delete(name)
			const metadata = getPerformanceExportErrorMetadata(error)
			if (metadata?.retryable === false) terminateDestination(name, error)
		})
		return operation
	}
	const runExporterFlush = (name: string, exporter: PerformanceEventExporterPort): Promise<void> => {
		const existing = pendingFlushHooks.get(name)
		if (existing) return existing
		const operation = Promise.resolve().then(async() => await exporter.flush?.())
		pendingFlushHooks.set(name, operation)
		void operation.then(
			() => pendingFlushHooks.delete(name),
			() => pendingFlushHooks.delete(name)
		)
		return operation
	}
	const runFlushCycle = async(flushExporterHooks: boolean) => {
		if (stopped || exporters.length === 0) {
			return
		}

		const failures: unknown[] = []
		await Promise.all(exporters.map(async({name, exporter}) => {
			if (terminalExporters.has(name)) {
				return
			}
			const boundary = logicalQueue.at(-1)?.id ?? -1
			let remainingBatchCount = countPending(name, boundary)
			let deliverySucceeded = remainingBatchCount === 0
			let failedAttempts = 0
			while (remainingBatchCount > 0) {
				// A timed-out operation can settle successfully while this loop is in
				// retry backoff. Its completion commits the records asynchronously, so
				// the local count is no longer authoritative. Re-read destination state
				// before materializing another batch; otherwise an empty batch has count
				// zero and the loop can spin forever without making progress.
				if (terminalExporters.has(name)) {
					failures.push(new Error('Exporter failed'))
					break
				}
				remainingBatchCount = countPending(name, boundary)
				if (remainingBatchCount === 0) {
					deliverySucceeded = true
					break
				}
				let delivery: Promise<void> | undefined
				try {
					delivery = deliverBatch(name, exporter, boundary)
					await withPerformanceExportTimeout(
						delivery,
						operationTimeoutMs,
						`Exporter "${name}"`
					)
					remainingBatchCount = countPending(name, boundary)
					deliverySucceeded = remainingBatchCount === 0
					failedAttempts = 0
				} catch(error) {
					const errorMetadata = getPerformanceExportErrorMetadata(error)
					if (errorMetadata?.code !== 'performance_export_timeout'
						&& delivery && pendingDeliveries.get(name) === delivery) {
						pendingDeliveries.delete(name)
					}
					const retryable = errorMetadata?.retryable ?? true
					if (!retryable || failedAttempts >= retryAttempts) {
						if (retryable) setExporterFailure(name, error)
						else terminateDestination(name, error)
						failures.push(error)
						break
					}
					failedAttempts += 1
					retriedTotal += 1
					emit('_performance_export_retries_total', 1)
					activeRetries += 1
					try { await sleep(retryBaseDelayMs * failedAttempts) } finally { activeRetries -= 1 }
				}
			}
			if (!deliverySucceeded || !flushExporterHooks || !exporter.flush || !exportersNeedingFlush.has(name)) return
			for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
				try {
					await withPerformanceExportTimeout(
						runExporterFlush(name, exporter),
						operationTimeoutMs,
						`Exporter "${name}" flush`
					)
					setExporterSuccess(name)
					exportersNeedingFlush.delete(name)
					break
				} catch(error) {
					if (attempt >= retryAttempts) {
						setExporterFailure(name, error)
						failures.push(error)
						break
					}
					retriedTotal += 1
					emit('_performance_export_retries_total', 1)
					activeRetries += 1
					try { await sleep(retryBaseDelayMs * (attempt + 1)) } finally { activeRetries -= 1 }
				}
			}

		})).then(() => {
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Performance event export flush failed')
			}
		})
	}

	const flush = async(flushExporterHooks = true) => {
		if (stopped || exporters.length === 0) return
		// One generation drains the current queue; at most one follow-up generation
		// is needed for work admitted while that drain is active. Coalescing here
		// prevents concurrent callers from manufacturing unbounded empty cycles.
		requestedFlushGeneration = Math.max(
			requestedFlushGeneration,
			completedFlushGeneration + (flushPromise ? 2 : 1)
		)
		requestedExporterHooks ||= flushExporterHooks
		if (!flushPromise) {
			flushPromise = (async() => {
				while (completedFlushGeneration < requestedFlushGeneration) {
					const targetGeneration = requestedFlushGeneration
					const runExporterHooks = requestedExporterHooks
					requestedExporterHooks = false
					await runFlushCycle(runExporterHooks)
					completedFlushGeneration = targetGeneration
				}
			})().finally(() => {
				flushPromise = null
			})
		}
		return flushPromise
	}

	if (exporters.length > 0 && flushIntervalMs > 0) {
		timer = setInterval(() => {
			void flush().catch(() => reportError({
				stage: 'performance', operation: 'event_export_timer_flush'
			}))
		}, flushIntervalMs)
		try { timer.unref?.() } catch { /* optional process-lifetime optimization */ }
	}

	return {
		enqueue(record: PerformanceEventRecord): void {
			if (stopped || closing || exporters.length === 0) {
				return
			}
			const activeNames = getActiveExporterNames()
			if (activeNames.length === 0) {
				droppedEvents += 1
				emit(DROPPED_TOTAL_METRIC, 1, {reason: 'terminal_exporter_unavailable'})
				return
			}
			const saturatedReason = logicalQueue.length >= maxBufferCount ? 'count_limit'
				: logicalQueueBytes >= maxBufferBytes ? 'byte_limit' : undefined
			if (saturatedReason && (partiallyCommittedRecords === 0 || activeNames.length < 2)) {
				droppedEvents += 1
				emit(DROPPED_TOTAL_METRIC, 1, {reason: saturatedReason})
				return
			}

			const snapshot = serializePerformanceEventRecord(record)
			if (snapshot === null || snapshot.bytes > MAX_PERFORMANCE_EXPORT_BATCH_BYTES) {
				droppedEvents += 1
				emit(DROPPED_TOTAL_METRIC, 1, {
					reason: snapshot ? 'record_size_limit' : 'serialization_error'
				})
				if (!snapshot) reportError({
					stage: 'performance', operation: 'event_export_enqueue'
				})
				return
			}

			let dropReason = logicalQueue.length >= maxBufferCount ? 'count_limit'
				: logicalQueueBytes + snapshot.bytes > maxBufferBytes ? 'byte_limit' : undefined
			while (dropReason && releasePartiallyCommittedRecord(activeNames.length)) {
				dropReason = logicalQueue.length >= maxBufferCount ? 'count_limit'
					: logicalQueueBytes + snapshot.bytes > maxBufferBytes ? 'byte_limit' : undefined
			}
			if (dropReason) {
				droppedEvents += 1
				emit(DROPPED_TOTAL_METRIC, 1, {reason: dropReason})
				return
			}
			logicalQueue.push({
				serialized: snapshot.serialized,
				bytes: snapshot.bytes,
				pending: new Set(activeNames),
				partial: false,
				id: nextSequence++
			})
			logicalQueueBytes += snapshot.bytes
			emit(QUEUE_SIZE_METRIC, logicalQueue.length)
		},
		flush,
		async shutdown(): Promise<void> {
			if (shutdownPromise) {
				return shutdownPromise
			}
			shutdownPromise = (async() => {
				closing = true
				if (timer !== undefined) {
					const activeTimer = timer
					timer = undefined
					try { clearInterval(activeTimer) } catch { /* finalization must continue */ }
				}
				const failures: unknown[] = []
				try {
					await flush(false)
				} catch(error) {
					failures.push(error)
				}
				const undelivered = logicalQueue.length
				if (undelivered > 0) {
					failures.push(new Error(`Performance event exporter shutdown left ${undelivered} event(s) undelivered`))
					// Retryable records are still owned by active exporters. Do not call
					// their lifecycle hooks yet: doing so can close the very exporter that
					// a later shutdown attempt must use to deliver the retained records.
					throw new AggregateError(failures, 'Performance event exporter shutdown failed')
				}
				await Promise.all(exporters.map(async({name, exporter}) => {
					if (completedExporterLifecycles.has(name)) return
					let failed = false
					if (exporter.flush) {
						try {
							await withPerformanceExportTimeout(
								lifecycleOperations.run(name, 'flush', () => runExporterFlush(name, exporter)),
								operationTimeoutMs,
								'Exporter flush'
							)
						} catch(error) { failed = true; failures.push(error) }
					}
					let shutdownCompleted = false
					if (exporter.shutdown) {
						try {
							await withPerformanceExportTimeout(
								lifecycleOperations.run(name, 'shutdown', () => exporter.shutdown?.()),
								operationTimeoutMs,
								'Exporter shutdown'
							)
							shutdownCompleted = true
						} catch(error) { failed = true; failures.push(error) }
					}
					if (!failed || shutdownCompleted) completedExporterLifecycles.add(name)
				}))
				if (failures.length > 0) {
					throw new AggregateError(failures, 'Performance event exporter shutdown failed')
				}
				stopped = true
			})().catch((error) => {
				shutdownPromise = null
				// Admission and background delivery stay closed after finalization has
				// started. A later shutdown call retries only the unresolved physical
				// work; it never reopens the periodic exporter interval.
				throw error
			})
			return shutdownPromise
		},
		getStatus(): EventExportStatus {
			const unhealthy = terminalExporters.size > 0 || [...exporterHealth.values()].some(({isHealthy}) => !isHealthy)
			return Object.freeze({
				queueSize: logicalQueue.length,
				droppedTotal: droppedEvents,
				retriedTotal,
				sinkState: stopped ? 'closed' : unhealthy ? 'unhealthy' : activeRetries > 0 ? 'degraded' : 'healthy',
				...(lastFailureCode ? {lastFailureCode} : {})
			})
		}
	}
}
