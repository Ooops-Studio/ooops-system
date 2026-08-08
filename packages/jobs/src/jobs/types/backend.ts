import type {
	DeadLetterSummary,
	JobPayload,
	JobRun,
	MisfirePolicy,
	OverlapPolicy,
	QueueStats,
	RetryPolicy,
	RunQuery,
	ScheduleDefinition,
	ScheduleQuery
} from '@ooopsstudio/core/contracts/jobs'

export interface JobTraceContext {
	traceparent: string
	tracestate?: string
	baggage?: string
}

export interface StoredJobRun extends Omit<JobRun, 'failureCode'> {
	failureCode?: string
	/** Legacy persisted field retained for storage compatibility only. */
	error?: string
	traceContext?: JobTraceContext
	retryPolicy: RetryPolicy
	idempotencyKey?: string
	idempotencyExpiresAt?: number
	idempotencyChecksum?: string
	leaseOwner?: string
	leaseToken?: string
	leaseExpiresAt?: number
	lastHeartbeatAt?: number
	terminalExpiresAt?: number
}

export interface StoredSchedule extends ScheduleDefinition {
	nextRunAt?: number
	lastTriggeredAt?: number
}

export interface StoredDeadLetter extends DeadLetterSummary {
	/** Legacy persisted fields retained internally and never projected publicly. */
	reason?: string
	error?: string
	payload?: JobPayload
}

export interface AppendRunIdempotency {
	key: string
	checksum: string
	expiresAt: number
}

export interface ClaimRunsRequest {
	now: number
	workerId: string
	limit: number
	maxConcurrentRuns: number
	leaseMs: number
	/** Restrict claims to tasks owned by this worker. Undefined retains low-level unrestricted behavior. */
	allowedTasks?: readonly string[]
	concurrencyByTask?: Readonly<Record<string, number>>
}

export interface TriggerSchedulesRequest {
	now: number
	maxCatchUp: number
	/** Restrict schedule triggering to tasks owned by this worker. Undefined is unrestricted. */
	allowedTasks?: readonly string[]
	/** Normal polling lateness that does not constitute a schedule misfire. */
	misfireGraceMs?: number
	terminalExpiresAt?: number
	allowedMisfire?: readonly MisfirePolicy[]
	allowedOverlap?: readonly OverlapPolicy[]
	createRun: (schedule: StoredSchedule, triggerTime: number) => StoredJobRun
}

export interface TriggeredScheduleResult {
	schedule: StoredSchedule
	triggerTimes: readonly number[]
	runs: readonly StoredJobRun[]
}

export interface JobsRunStore {
	appendRun(run: StoredJobRun, idempotency?: AppendRunIdempotency): Promise<{run: StoredJobRun; existing: boolean}>
	getRun(runId: string): Promise<StoredJobRun | undefined>
	claimDueRuns(request: ClaimRunsRequest): Promise<StoredJobRun[]>
	releaseClaim(runId: string, leaseToken: string, now: number): Promise<boolean>
	renewLease(runId: string, leaseToken: string, leaseExpiresAt: number, now: number): Promise<boolean>
	completeRun(run: StoredJobRun, leaseToken: string): Promise<boolean>
	markRunRetryable(run: StoredJobRun, leaseToken: string): Promise<boolean>
	deadLetterRun(run: StoredJobRun, leaseToken: string, deadLetter: StoredDeadLetter): Promise<boolean>
	cancelRun(
		runId: string,
		reason: string | undefined,
		expectedLeaseToken: string | undefined,
		now: number,
		terminalExpiresAt?: number
	): Promise<boolean>
	recoverStaleLeases(now: number, recoveryAfterMs: number, terminalExpiresAt?: number): Promise<number>
}

export interface JobsScheduleStore {
	saveSchedule(schedule: StoredSchedule, expected?: StoredSchedule | null): Promise<boolean>
	setScheduleEnabled(
		scheduleId: string,
		enabled: boolean,
		nextRunAt?: number,
		expected?: StoredSchedule
	): Promise<boolean>
	getSchedule(scheduleId: string): Promise<StoredSchedule | undefined>
	deleteSchedule(scheduleId: string): Promise<void>
	triggerDueSchedules(request: TriggerSchedulesRequest): Promise<TriggeredScheduleResult[]>
}

export interface JobsMaintenanceStore {
	cleanupTerminalRuns(now: number, limit: number): Promise<number>
}

export interface JobsAdminStore {
	listRuns(query?: RunQuery): Promise<StoredJobRun[]>
	listSchedules(query?: ScheduleQuery): Promise<StoredSchedule[]>
	setQueuePaused(queue: string, paused: boolean): Promise<void>
	listDeadLetters(limit?: number): Promise<StoredDeadLetter[]>
	getDeadLetter(deadLetterId: string): Promise<StoredDeadLetter | undefined>
	requeueDeadLetter(
		deadLetterId: string,
		run: StoredJobRun,
		idempotency?: AppendRunIdempotency
	): Promise<StoredJobRun | undefined>
	triggerScheduleNow(
		scheduleId: string,
		createRun: (schedule: StoredSchedule) => StoredJobRun
	): Promise<StoredJobRun[]>
	getQueueStats(queue?: string, now?: number): Promise<QueueStats[]>
}

export interface JobsBackend {
	readonly durability: 'ephemeral' | 'durable'
	readonly runs: JobsRunStore
	readonly schedules: JobsScheduleStore
	readonly maintenance: JobsMaintenanceStore
	readonly admin?: JobsAdminStore
}

/** Internal flattened view used by the runtime after public-boundary capture. */
export interface JobsBackendRuntime extends JobsRunStore, JobsScheduleStore, JobsMaintenanceStore {
	readonly durability: JobsBackend['durability']
	readonly admin?: JobsAdminStore
}

/** Internal constructor shape used by the built-in stores before composition. */
export interface FlatJobsBackendRuntime extends JobsRunStore, JobsScheduleStore, JobsMaintenanceStore, JobsAdminStore {
	readonly durability: JobsBackend['durability']
}

export interface JobsSqlQueryPort {
	query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<{rows: T[]}>
}

export interface JobsSqlAdapterPort extends JobsSqlQueryPort {
	transaction<T>(fn: (transaction: JobsSqlQueryPort) => Promise<T>): Promise<T>
}

export interface JobsRedisPort {
	eval?<T = unknown>(
		script: string,
		keys: ReadonlyArray<string>,
		args?: ReadonlyArray<string | number>
	): Promise<T>
	ping?(): Promise<boolean>
}

export interface JobsMemoryBackendOptions {namespace?: string}
export interface JobsRedisBackendOptions {redis: JobsRedisPort; namespace?: string}
export interface JobsSqlBackendOptions {sql: JobsSqlAdapterPort; namespace?: string}
