// Queue limits for the immutable production backpressure policy.
export const QUEUE_ITEMS_PRODUCTION = 10_000
export const QUEUE_BYTES_PRODUCTION = 10_000_000
export const MAX_ACTIVE_LOG_PIPELINES = 1_000
export const MAX_ACTIVE_DIRECT_DELIVERIES = 1_000
export const MAX_ACTIVE_TRANSFERS = 1_000
export const MAX_ACTIVE_PROVIDER_OPERATIONS = 1_000
/** Physical fetch operations retained by one remote sink, including timed-out requests. */
export const MAX_ACTIVE_REMOTE_REQUESTS = 100

// Finalization bounds
export const LOGGING_FLUSH_TIMEOUT_MS = 5_000
export const LOGGING_SHUTDOWN_TIMEOUT_MS = 10_000
/** Largest delay Node timers can represent without silently clamping to 1 ms. */
export const MAX_LOGGING_TIMER_MS = 2_147_483_647

// Server production batching configuration
export const BATCH_SIZE_SERVER_PROD = 50
export const BATCH_INTERVAL_SERVER_PROD_MS = 500

// Client production batching configuration
export const BATCH_SIZE_CLIENT_PROD = 10
export const BATCH_INTERVAL_CLIENT_PROD_MS = 300

// Retry configuration
export const RETRY_MAX_ATTEMPTS_SERVER_PROD = 3
export const RETRY_MAX_ATTEMPTS_CLIENT_PROD = 1

// Self-monitoring metric names
export const LOG_SELF_WRITTEN_TOTAL = '_logs_written_total'
export const LOG_SELF_DROPPED_TOTAL = '_logs_dropped_total'
export const LOG_SELF_RETRIED_TOTAL = '_logs_retried_total'
export const LOG_SELF_QUEUE_SIZE = '_logs_queue_size'
export const LOG_SELF_SINK_FAILURES_TOTAL = '_logs_sink_failures_total'
export const LOG_SELF_FINALIZATION_FAILURES_TOTAL = '_logs_finalization_failures_total'
