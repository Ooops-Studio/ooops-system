import type {
	DeadLetterSummary,
	JobEnqueueOptions,
	JobPayload,
	JobResult,
	JobRun,
	JobsStatus,
	QueueStats,
	RunQuery,
	ScheduleDefinition,
	ScheduleQuery,
	ScheduleStatus,
	TaskDefinition
} from '../contracts/jobs'

export interface RegisteredTaskHandlerContext {
	runId: string
	attempt: number
	queue: string
	payload: JobPayload
	signal: AbortSignal
}

export type RegisteredTaskHandler = (
	context: RegisteredTaskHandlerContext
) => Promise<JobResult> | JobResult

export interface JobsPort {
	enqueue(task: string, payload?: JobPayload, options?: JobEnqueueOptions): Promise<{runId: string}>
	upsertSchedule(definition: ScheduleDefinition): Promise<{scheduleId: string}>
	pauseSchedule(scheduleId: string): Promise<void>
	resumeSchedule(scheduleId: string): Promise<void>
	deleteSchedule(scheduleId: string): Promise<void>
	getRun(runId: string): Promise<JobRun | undefined>
	cancelRun(runId: string, reason?: string): Promise<void>
}

export interface ManagedJobs extends JobsPort {
	registerTask(definition: TaskDefinition, handler: RegisteredTaskHandler): void
	start(): Promise<void>
	getStatus(): JobsStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
}

export interface JobsAdminPort {
	listRuns(query?: RunQuery): Promise<JobRun[]>
	listSchedules(query?: ScheduleQuery): Promise<ScheduleStatus[]>
	listDeadLetters(): Promise<DeadLetterSummary[]>
	getQueueStats(queue?: string): Promise<QueueStats[]>
	pauseQueue(queue: string): Promise<void>
	resumeQueue(queue: string): Promise<void>
	retryRun(runId: string): Promise<{runId: string}>
	requeueDeadLetter(deadLetterId: string): Promise<{runId: string}>
	triggerScheduleNow(scheduleId: string): Promise<Array<{runId: string}>>
}

export interface JobsRuntime {
	jobs: ManagedJobs
	admin?: JobsAdminPort
}
