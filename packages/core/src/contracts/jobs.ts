import type {JsonValue} from './json'

export type JobValue = JsonValue | undefined
export type JobPayload = Record<string, JobValue>
export type JobResult = JobValue | JobPayload

export type JobStatus =
	| 'queued'
	| 'running'
	| 'retryable'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'dead-lettered'
export type ScheduleKind = 'cron' | 'interval'
export type MisfirePolicy = 'skip' | 'fire-once' | 'catch-up'
export type OverlapPolicy = 'allow' | 'skip' | 'queue'

export interface BackoffPolicy {
	kind: 'fixed' | 'linear' | 'exponential'
	factor?: number
}

export interface RetryPolicy {
	attempts: number
	baseDelayMs: number
	maxDelayMs?: number
	backoff?: BackoffPolicy
	jitter?: 'none' | 'full' | 'bounded'
}

export interface LeasePolicy {
	leaseMs: number
	recoveryAfterMs?: number
}

export interface TaskDefinition {
	name: string
	queue?: string
	priority?: number
	concurrency?: number
	timeoutMs?: number
}

export interface SchedulePolicy {
	misfire: MisfirePolicy
	overlap: OverlapPolicy
	timezone?: string
}

export interface ScheduleDefinition {
	id: string
	task: string
	kind: ScheduleKind
	cron?: string
	intervalMs?: number
	policy?: SchedulePolicy
	payload?: JobPayload
	queue?: string
	startAt?: number
	endAt?: number
	enabled?: boolean
}

export interface JobRun {
	id: string
	task: string
	queue: string
	payload: JobPayload
	status: JobStatus
	createdAt: number
	updatedAt: number
	runAt: number
	priority: number
	attempt: number
	maxAttempts: number
	scheduleId?: string
	output?: JobResult
	failureCode?: string
	cancelReason?: string
	startedAt?: number
	completedAt?: number
	terminalAt?: number
}

export interface JobEnqueueOptions {
	queue?: string
	runAt?: number
	priority?: number
	idempotencyKey?: string
}

export interface ScheduleStatus extends ScheduleDefinition {
	nextRunAt?: number
	lastTriggeredAt?: number
}

export interface QueueStats {
	queue: string
	queued: number
	running: number
	retryable: number
	deadLettered: number
	completed: number
	failed: number
	cancelled: number
	paused: boolean
	lagMs: number
}

export interface DeadLetterSummary {
	id: string
	runId: string
	queue: string
	task: string
	failureCode: string
	attempts: number
	failedAt: number
}

export interface RunQuery {
	queue?: string
	status?: JobStatus | JobStatus[]
	task?: string
	scheduleId?: string
	limit?: number
	offset?: number
}

export interface ScheduleQuery {
	queue?: string
	enabled?: boolean
	task?: string
	limit?: number
	offset?: number
}

export type JobsRuntimeState = 'idle' | 'running' | 'draining' | 'closed'
export type JobsBackendState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface JobsStatus {
	state: JobsRuntimeState
	backendState: JobsBackendState
	activeRuns: number
	activeOperations: number
	retriedTotal: number
	deadLetteredTotal: number
	lastFailureCode?: string
}
