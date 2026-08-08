/**
 * Foundation contracts, dependency-injection tokens, and runtime helpers for
 * Ooops System packages. Concrete services deliberately live in sibling
 * packages so this package stays dependency-free.
 */

export {createContainer} from './runtime/container'
export type {Container} from './runtime/container'
export {TOK} from './tokens'
export type {Tokens} from './tokens'
export type {Clock, Deadline} from './contracts/clock'
export type {RuntimeContext} from './contracts/context'
export type {NormalizedError, ErrorSeverity, ErrorCategory, EnrichedError} from './contracts/errors'
export type {JsonPrimitive, JsonValue, JsonArray, JsonObject} from './contracts/json'
export type {LogLevel, LogAttributes, LogTags, LogContext, LogRecord} from './contracts/logging'
export type {
	ObservabilityResource,
	TraceCorrelationFields,
	MetricsExemplarMetadata
} from './contracts/observability-shared'
export type {SpanKind, SpanContext, TracingContext, SpanStatus, SpanEvent, SpanLink, SpanRecord} from './contracts/tracing'
export type {
	LifecycleRuntimeState,
	LifecycleHealthState,
	LifecycleStartupStage,
	ProbeStatus,
	LifecycleShutdownReason,
	LifecycleDegradationSeverity,
	LifecycleStatus,
	LifecycleHealthCheckResult,
	LifecycleHealthCheckContext,
	LifecycleHealthCheckDefinition,
	LifecycleHealthCheckSnapshot,
	LifecycleHealthSnapshot,
	LifecycleStartupContext,
	LifecycleShutdownContext,
	LifecycleFlushContext,
	StartupHook,
	ShutdownHook,
	LifecycleFlushHook,
	LifecycleHookDisposer,
	LifecycleStartupHookOptions,
	LifecycleShutdownHookOptions,
	LivenessProbeResponse,
	ReadinessProbeResponse
} from './contracts/lifecycle'
export {
	LifecycleError,
	LifecycleStartupError,
	LifecycleShutdownTimeoutError
} from './contracts/lifecycle'
export type {Errors} from './ports/errors'
export type {LifecyclePort, ManagedLifecycle} from './ports/lifecycle'
export type {Logging, LogMethod} from './ports/logging'
export type {MetricsPort} from './ports/metrics'
export type {TracerPort, Tracing, TracingSpan, SpanOptions, InjectOptions, ExtractResult} from './ports/tracing'
export type {ProfileCaptureOptions, ProfileCaptureSummary} from './contracts/profiling'
export type {
	CacheBackendState,
	CacheEntryMetadata,
	CacheGetOptions,
	CacheInvalidateRequest,
	CacheKey,
	CacheLoadOptions,
	CacheNamespace,
	CacheRuntimeState,
	CacheSetOptions,
	CacheStatus
} from './contracts/cache'
export type {
	BackendErrorPolicy,
	RateLimitAlgorithm,
	RateLimitBackendState,
	RateLimitBatchDecision,
	RateLimitCheckRequest,
	RateLimitDecision,
	RateLimitDecisionReason,
	RateLimitMode,
	RateLimitPartition,
	RateLimitPolicyDefinition,
	RateLimitRuntimeState,
	RateLimitStatus
} from './contracts/rate-limit'
export type {
	FallbackStrategy,
	ResilienceBulkheadPolicyDefinition,
	ResilienceCircuitBreakerPolicyDefinition,
	ResilienceClassificationResult,
	ResilienceCoalescingPolicyDefinition,
	ResilienceErrorClassifier,
	ResilienceExecutionContext,
	ResilienceExecutionRequest,
	ResilienceMetadataValue,
	ResilienceOperationKind,
	ResiliencePolicyDefinition,
	ResilienceRetryClassifier,
	ResilienceRetryPolicyDefinition,
	ResilienceRuntimeState,
	ResilienceStatus
} from './contracts/resilience'
export {
	BreakerOpenError,
	BulkheadOverflowError,
	ResilienceConfigurationError,
	ResilienceError,
	RetryExhaustedError,
	TimedOutError
} from './contracts/resilience'
export type {
	AuditActor,
	AuditActorKind,
	AuditChangeSet,
	AuditCorrelation,
	AuditExportChunk,
	AuditExportFormat,
	AuditExportOptions,
	AuditExportRequest,
	AuditExportResult,
	AuditIntegrity,
	AuditIntegrityAlgorithm,
	AuditIntegrityVerificationOptions,
	AuditIntegrityVerificationResult,
	AuditOutcome,
	AuditPage,
	AuditPruneOptions,
	AuditPruneRequest,
	AuditPruneResult,
	AuditQuery,
	AuditQueryResult,
	AuditRecord,
	AuditSensitivity,
	AuditStoreRetentionResult,
	AuditTarget,
	AuditVerificationFilter,
	AuditVerificationResult,
	AuditWriteActor,
	AuditWriteCorrelation,
	AuditWriteRequest
} from './contracts/audit'
export type {
	BudgetStatus,
	BudgetViolation,
	DBQueryEvent,
	DBQueryMetadata,
	HttpPerfMetadata,
	N1Pattern,
	PerfEvent,
	PerformanceEventRecord,
	PerformanceMeasurement,
	PerformanceSpanOptions,
	SaturationAlert
} from './contracts/performance'
export type {
	ContinuousProfiler,
	ContinuousProfilerStatus,
	CpuProfileArtifact,
	CpuProfiler,
	ProfileExporter,
	ProfilingPort
} from './ports/profiling'
export type {PerformanceEventExporterPort, PerformancePort} from './ports/performance'
export type {
	AuditAdminPort,
	AuditPort,
	AuditRuntime,
	AuditRuntimeState,
	AuditStatus,
	ManagedAudit,
	TransactionalAuditPort
} from './ports/audit'
export type {
	CacheBackendPort,
	CachePort,
	CacheRedisPort,
	CacheServicePort,
	ManagedCache
} from './ports/cache'
export type {ManagedRateLimit, RateLimitPort} from './ports/ratelimit'
export type {ResilienceOperation, ResiliencePort} from './ports/resilience'
export type {
	EventsAdminPort,
	EventsPort,
	EventsRuntime,
	ManagedEvents,
	TransactionalEventsPort
} from './ports/events'
export type {
	JobsAdminPort,
	JobsPort,
	JobsRuntime,
	ManagedJobs,
	RegisteredTaskHandler,
	RegisteredTaskHandlerContext
} from './ports/jobs'
export type {
	EventConsumerContext,
	EventConsumerDefinition,
	EventConsumerHandler,
	EventConsumerResult,
	EventDeadLetterSummary,
	EventDefinition,
	EventDeliveryStatus,
	EventDestinationBinding,
	EventEnvelope,
	EventOutboxSummary,
	EventPayloadSchema,
	EventPublishOptions,
	EventPublishRequest,
	EventReplayRequest,
	EventTransportKind,
	EventsBackendState,
	EventsRuntimeState,
	EventsStatus
} from './contracts/events'
export type {
	BackoffPolicy as JobsBackoffPolicy,
	DeadLetterSummary,
	JobEnqueueOptions,
	JobPayload,
	JobResult,
	JobRun,
	JobStatus,
	JobValue,
	JobsBackendState,
	JobsRuntimeState,
	JobsStatus,
	LeasePolicy,
	MisfirePolicy,
	OverlapPolicy,
	QueueStats,
	RetryPolicy as JobsRetryPolicy,
	RunQuery,
	ScheduleDefinition,
	ScheduleKind,
	SchedulePolicy,
	ScheduleQuery,
	ScheduleStatus,
	TaskDefinition
} from './contracts/jobs'
