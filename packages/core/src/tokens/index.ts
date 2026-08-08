/** Stable DI tokens shared by the extracted observability packages. */
export const TOK = Object.freeze({
	Clock: Symbol.for('@ooopsstudio/clock'),
	Logging: Symbol.for('@ooopsstudio/logging'),
	Errors: Symbol.for('@ooopsstudio/errors'),
	Metrics: Symbol.for('@ooopsstudio/metrics'),
	Tracing: Symbol.for('@ooopsstudio/tracing'),
	Lifecycle: Symbol.for('@ooopsstudio/lifecycle'),
	Profiling: Symbol.for('@ooopsstudio/profiling'),
	Performance: Symbol.for('@ooopsstudio/performance'),
	Audit: Symbol.for('@ooopsstudio/audit'),
	AuditAdmin: Symbol.for('@ooopsstudio/audit-admin'),
	AuditTransactional: Symbol.for('@ooopsstudio/audit-transactional'),
	Cache: Symbol.for('@ooopsstudio/cache'),
	RateLimit: Symbol.for('@ooopsstudio/ratelimit'),
	Resilience: Symbol.for('@ooopsstudio/resilience'),
	Events: Symbol.for('@ooopsstudio/events'),
	EventsTransactional: Symbol.for('@ooopsstudio/events-transactional'),
	EventsAdmin: Symbol.for('@ooopsstudio/events-admin'),
	Jobs: Symbol.for('@ooopsstudio/jobs'),
	JobsAdmin: Symbol.for('@ooopsstudio/jobs-admin')
})

export type Tokens = typeof TOK
