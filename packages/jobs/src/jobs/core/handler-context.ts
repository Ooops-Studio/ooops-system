import {createHash, randomUUID} from 'node:crypto'

import type {JobPayload, RetryPolicy} from '@ooopsstudio/core/contracts/jobs'

import {createJobsTelemetryController, type JobsTelemetryController, type JobsTracing} from '../runtime-capabilities'
import type {JobTraceContext} from '../types/backend'
import type {
	InternalRun,
	InternalTaskRegistration,
	JobsRuntimeState,
	JobsHandlerOptions
} from '../types/jobs'

import {addJobsDuration, clone, enqueueRequestChecksum, idempotencyStorageKey, MAX_JOBS_TIMESTAMP, positiveInteger, snapshotJobTraceContext} from './handler-helpers'
import {projectJobFailure} from './handler-projections'

export const MAX_ACTIVE_JOBS_MUTATIONS = 1_024
export const MAX_ACTIVE_JOBS_TRACING_OPERATIONS = 1_024
const MAX_ACTIVE_JOBS_MUTATION_OWNERS = MAX_ACTIVE_JOBS_MUTATIONS * 2

export interface RuntimeControl {
	started: boolean
	destroyed: boolean
	draining: boolean
	registrationClosed: boolean
	start?: Promise<void>
	timer?: ReturnType<typeof setInterval>
	tick?: Promise<void>
	flush?: Promise<void>
	shutdown?: Promise<void>
}

export interface JobsKernelContext {
	options: JobsHandlerOptions
	state: JobsRuntimeState
	tasks: Map<string, InternalTaskRegistration>
	control: RuntimeControl
	workerId: string
	activeExecutions: Set<Promise<void>>
	activeTaskOperations: Set<Promise<void>>
	activeMutations: Set<Promise<void>>
	activeTracingOperations: Set<Promise<unknown>>
	telemetry: JobsTelemetryController
	getTracer(): JobsTracing | undefined
	trackMutation<T>(operation: () => Promise<T>, critical?: boolean): Promise<T>
	now(): number
	ensureActive(operation: string): void
	rememberCancellation(runId: string): void
	log(level: 'debug' | 'info' | 'warn' | 'error', message: string, attributes?: Record<string, unknown>): void
	metric(name: string, value?: number, tags?: Record<string, string>): void
	report(error: unknown, operation: string, attributes?: Record<string, unknown>): void
	diagnosticError(operation: string): Error
	sanitizeAttributes(attributes?: Record<string, unknown>): Record<string, unknown> | undefined
	captureTraceContext(): JobTraceContext | undefined
	withProducerSpan<T>(name: string, attributes: Record<string, unknown>, operation: () => Promise<T>): Promise<T>
	createRun(task: string, payload: JobPayload, enqueueOptions?: {
		queue?: string; runAt?: number; priority?: number; idempotencyKey?: string; scheduleId?: string
	}): InternalRun
}

export function createJobsKernelContext(options: JobsHandlerOptions): JobsKernelContext {
	const state: JobsRuntimeState = {
		activeControllers: new Map(), activeRunSchedules: new Map(), locallyCancelledActiveRunIds: new Set(),
		recentlyCancelledRunIds: new Set(),
		cancellationFenceOverflow: false, cancellationFenceGeneration: 0n, timedOutRunIds: new Set(),
		timedOutTaskOperations: new Map(),
		executionFailures: [], backgroundFailures: [], retriedTotal: 0, deadLetteredTotal: 0,
		backendState: 'healthy'
	}
	const tasks = new Map<string, InternalTaskRegistration>()
	const telemetry = createJobsTelemetryController()
	const namespace = options.namespace ?? 'jobs'
	const now = () => {
		const timestamp = options.clock.now()
		if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_JOBS_TIMESTAMP) {
			throw new Error('Jobs clock must return a non-negative safe integer timestamp')
		}
		return timestamp
	}
	const fingerprint = (kind: string, value: string): string =>
		`${kind}_${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
	const sanitizeAttributes = (attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
		if (!attributes) return undefined
		return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [
			key,
			typeof value === 'string' && ['runId', 'queue', 'task'].includes(key)
				? fingerprint(key === 'runId' ? 'run' : key, value)
				: value
		]))
	}
	const context: JobsKernelContext = {
		options,
		state,
		tasks,
		control: {started: false, destroyed: false, draining: false, registrationClosed: false},
		workerId: `jobs-${randomUUID()}`,
		activeExecutions: new Set(),
		activeTaskOperations: new Set(),
		activeMutations: new Set(),
		activeTracingOperations: new Set(),
		telemetry,
		getTracer: () => telemetry.getTracer(),
		trackMutation<T>(operation: () => Promise<T>, critical = false): Promise<T> {
			const limit = critical ? MAX_ACTIVE_JOBS_MUTATION_OWNERS : MAX_ACTIVE_JOBS_MUTATIONS
			if (context.activeMutations.size >= limit) {
				telemetry.emit({kind: 'rejected', reason: 'capacity'})
				return Promise.reject(new Error('Jobs mutation capacity exceeded'))
			}
			let settle!: () => void
			const ownership = new Promise<void>((resolve) => { settle = resolve })
			context.activeMutations.add(ownership)
			try {
				return Promise.resolve(operation()).finally(() => {
					settle()
					context.activeMutations.delete(ownership)
				})
			} catch(error) {
				settle()
				context.activeMutations.delete(ownership)
				return Promise.reject(error)
			}
		},
		now,
		sanitizeAttributes,
		diagnosticError(operation) {
			const normalized = new Error(`jobs_${operation.replace(/[^a-z0-9]+/giu, '_').slice(0, 64)}_failed`)
			normalized.name = 'JobsDiagnosticError'
			normalized.stack = undefined
			return normalized
		},
		captureTraceContext() {
			try {
				const carrier: Record<string, string> = {}
				telemetry.getTracer()?.injectHeaders(carrier)
				if (!carrier.traceparent) return undefined
				return snapshotJobTraceContext({
					traceparent: carrier.traceparent,
					...(carrier.tracestate ? {tracestate: carrier.tracestate} : {}),
					...(carrier.baggage ? {baggage: carrier.baggage} : {})
				})
			} catch(error) {
				context.report(error, 'tracing')
				return undefined
			}
		},
		async withProducerSpan<T>(name: string, attributes: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
			const tracer = telemetry.getTracer()
			if (!tracer || context.activeTracingOperations.size >= MAX_ACTIVE_JOBS_TRACING_OPERATIONS) return operation()
			let physical: Promise<T> | undefined
			const invoke = () => physical ??= Promise.resolve().then(operation)
			let tracing: Promise<T> | undefined
			try {
				tracing = Promise.resolve(tracer.inSpan(name, () => invoke(), {
					kind: 'producer', attributes: context.sanitizeAttributes(attributes) as never
				}))
			} catch(error) { context.report(error, 'tracing') }
			if (!tracing) return invoke()
			context.activeTracingOperations.add(tracing)
			const physicalOperation = invoke()
			const tracingObservation = tracing.catch((error) => {
				context.report(error, 'tracing')
			}).finally(() => context.activeTracingOperations.delete(tracing))
			// Tracing is observational. A hostile tracer may invoke the callback and
			// then never settle; retain only a bounded ownership slot so later jobs
			// fail open without accumulating additional dangling trace operations.
			void tracingObservation.catch(() => undefined)
			return physicalOperation
		},
		rememberCancellation(runId) {
			state.cancellationFenceGeneration += 1n
			const maximum = Math.max(2_048, (options.maxConcurrentRuns ?? 4) * 2)
			if (state.recentlyCancelledRunIds.size >= maximum) state.cancellationFenceOverflow = true
			if (state.cancellationFenceOverflow) return
			state.recentlyCancelledRunIds.add(runId)
		},
		ensureActive(operation) {
			if (context.control.destroyed || context.control.draining) {
				telemetry.emit({kind: 'rejected', reason: context.control.destroyed ? 'closed' : 'draining'})
				throw new Error(`Jobs scheduler cannot ${operation} after shutdown has started`)
			}
		},
		log(level, message, attributes) {
			telemetry.emit({kind: 'log', level, message, ...(attributes ? {attributes: sanitizeAttributes(attributes)} : {})})
		},
		metric(name) {
			if (name === 'jobs_runs_retried_total') telemetry.emit({kind: 'retry'})
			else if (name === 'jobs_runs_completed_total') telemetry.emit({kind: 'execution', result: 'completed'})
			else if (name === 'jobs_runs_dead_lettered_total') telemetry.emit({kind: 'execution', result: 'dead_lettered'})
		},
		report(error, operation) {
			const mapped = operation === 'schedule-trigger' || operation === 'stale-recovery' || operation === 'run-claim'
				? operation
				: operation === 'task-run' ? 'execution'
					: operation.includes('lease') ? 'lease'
						: operation === 'maintenance' ? 'maintenance'
							: operation === 'tracing' ? 'tracing' : 'backend'
			telemetry.emit({
				kind: 'operation_failed', operation: mapped,
				code: operation === 'task-run' ? projectJobFailure(error) : `JOBS_${operation.replace(/[^a-z0-9]+/giu, '_').toUpperCase()}_FAILED`,
				error,
				reportable: operation === 'task-run' || mapped !== 'tracing'
			})
		},
		createRun(task, payload, enqueueOptions = {}) {
			const registration = tasks.get(task)
			if (!registration) throw new Error(`Task not registered: ${task}`)
			const createdAt = now()
			const idempotencyKey = enqueueOptions.idempotencyKey
				? idempotencyStorageKey(namespace, task, enqueueOptions.idempotencyKey)
				: undefined
			const retry: RetryPolicy = clone(options.retry)
			const storedPayload = clone(payload)
			const queue = enqueueOptions.queue ?? registration.definition.queue ?? options.defaultQueue ?? 'default'
			const priority = enqueueOptions.priority ?? registration.definition.priority ?? 0
			const traceContext = context.captureTraceContext()
			const run: InternalRun = {
				id: randomUUID(), task,
				queue,
				payload: storedPayload, status: 'queued', createdAt, updatedAt: createdAt,
				runAt: enqueueOptions.runAt ?? createdAt,
				priority,
				attempt: 0, maxAttempts: positiveInteger(retry.attempts, 1), retryPolicy: retry,
				...(idempotencyKey ? {
					idempotencyKey,
					idempotencyExpiresAt: addJobsDuration(createdAt, 86_400_000, 'Jobs idempotency expiry'),
					idempotencyChecksum: enqueueRequestChecksum(
						storedPayload, queue, priority, enqueueOptions.runAt
					)
				} : {}),
				...(enqueueOptions.scheduleId ? {scheduleId: enqueueOptions.scheduleId} : {}),
				...(traceContext ? {traceContext} : {})
			}
			return run
		}
	}
	return context
}
