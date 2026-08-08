/**
 * @file Configuration constants for metrics service.
 * Shared constants for presets, histogram buckets, and metric naming.
 */

/**
 * Label limits per preset
 */
export const LABEL_LIMITS_DEVELOPMENT = {
	maxLabels: 20,
	maxCardinality: 1000
} as const

export const LABEL_LIMITS_PRODUCTION = {
	maxLabels: 10,
	maxCardinality: 100
} as const

/**
 * Buffer flush intervals (milliseconds)
 */
export const BUFFER_FLUSH_INTERVAL_DEVELOPMENT = 500
export const BUFFER_FLUSH_INTERVAL_PRODUCTION = 1000

/**
 * Histogram bucket configuration
 * Shared across presets for consistency
 */
export const HISTOGRAM_BUCKETS_DEFAULT = [
	0.005, 0.01, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
] as const

export const HISTOGRAM_MAX_BUCKETS = 256

/**
 * Metric naming constants
 * Ensures consistent naming across bridges
 */
export const METRIC_ERRORS_TOTAL = '_errors_total'
export const METRIC_ERRORS_BY_TYPE_TOTAL = '_errors_by_type_total'
export const METRIC_ERRORS_BY_CATEGORY = '_errors_{category}' // Template
export const METRIC_ERRORS_BY_SEVERITY = '_errors_{severity}' // Template

export const METRIC_LOGS_TOTAL = '_logs_total'
export const METRIC_LOGS_BY_LEVEL_TOTAL = '_logs_by_level_total'

/**
 * Self-monitoring metric names
 */
export const METRIC_SELF_RECORDED_TOTAL = '_metrics_recorded_total'
export const METRIC_SELF_DROPPED_TOTAL = '_metrics_dropped_total'
export const METRIC_SELF_EXPORT_FAILURES_TOTAL = '_metrics_export_failures_total'
export const METRIC_SELF_EXPORT_RETRIES_TOTAL = '_metrics_export_retries_total'
export const METRIC_SELF_QUEUE_SIZE = '_metrics_queue_size'
export const METRIC_SELF_FINALIZATION_FAILURES_TOTAL = '_metrics_finalization_failures_total'
export const METRIC_SELF_ACTIVE_SERIES = '_metrics_active_series'

/**
 * Buffer and estimation constants
 */
export const BYTES_PER_METRIC_ENTRY = 200 // Rough estimate per buffered entry
export const HEALTH_CHECK_INTERVAL_MS = 30000 // Check every 30 seconds
export const JITTER_FACTOR = 0.3 // ±30% jitter for retry backoff
export const CARDINALITY_WARNING_THRESHOLD = 0.8 // 80% of max cardinality triggers warning
export const CARDINALITY_TRACKER_MAX_KEYS = 1000 // Maximum distinct metric names tracked per handler
/** Hard input ceiling before configured label limits are applied. */
export const METRIC_MAX_RAW_LABELS = 256
/** Avoid scanning or retaining attacker-controlled multi-megabyte label values. */
export const METRIC_MAX_RAW_LABEL_VALUE_LENGTH = 4096
/** Hard ceiling across every metric name owned by one cardinality tracker. */
export const CARDINALITY_TRACKER_MAX_SERIES = 100_000

/**
 * Default configuration values
 */
export const DEFAULT_BUFFER_FLUSH_INTERVAL_MS = 1000 // Default buffer flush interval
export const DEFAULT_FLUSH_TIMEOUT_MS = 5000 // Default explicit flush timeout
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000 // Default shutdown timeout
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2000 // Default exporter health check timeout
/** Largest delay accepted by Node-compatible timer APIs without overflow. */
export const MAX_METRICS_TIMER_MS = 2_147_483_647
export const PRODUCTION_STALE_SERIES_AFTER_MS = 5 * 60 * 1000 // 5 minutes
export const DEFAULT_MAX_BUFFER_COUNT = 10000 // Default max buffer count
export const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024 // Default max buffer bytes (1MB)
/** Hard ceilings preserve bounded memory under custom and direct construction. */
export const METRICS_HARD_MAX_BUFFER_COUNT = 1_000_000
export const METRICS_HARD_MAX_BUFFER_BYTES = 64 * 1024 * 1024
export const DEFAULT_EXPORTER_QUEUE_MAX_BATCHES = DEFAULT_MAX_BUFFER_COUNT
export const DEFAULT_EXPORTER_QUEUE_MAX_BYTES = DEFAULT_MAX_BUFFER_BYTES

/**
 * Prometheus exporter defaults
 */
export const PROMETHEUS_HTTP_HOST = '127.0.0.1' // Default Prometheus HTTP host
export const PROMETHEUS_HTTP_PORT = 9090 // Default Prometheus HTTP port
export const PROMETHEUS_MAX_BUFFER_SIZE = 1024 * 1024 // Default Prometheus buffer size (1MB)
export const PROMETHEUS_MAX_BUFFER_LINES = 5000 // Default Prometheus buffer lines
/** Hard ceilings preserve the sink's bounded-memory contract under custom configuration. */
export const PROMETHEUS_HARD_MAX_BUFFER_SIZE = 64 * 1024 * 1024
export const PROMETHEUS_HARD_MAX_BUFFER_LINES = 100_000

/**
 * Exporter retry defaults
 */
export const EXPORTER_RETRY_MAX_RETRIES = 3 // Default max retries
export const METRICS_MAX_RETRIES = 10 // Prevent unbounded retry amplification
export const EXPORTER_RETRY_BASE_DELAY_MS = 100 // Default base delay
export const EXPORTER_RETRY_MAX_DELAY_MS = 1000 // Default max delay
export const EXPORTER_RETRY_MULTIPLIER = 2 // Default backoff multiplier

/**
 * Exporter timeout defaults
 */
export const OTLP_EXPORTER_TIMEOUT_MS = 5000 // Default OTLP exporter timeout
/** Bound retained request-target configuration and URL parser work. */
export const OTLP_MAX_ENDPOINT_LENGTH = 8_192
/** Raw OTLP sinks bypass ExporterManager, so the transport owns this hard ceiling. */
export const OTLP_MAX_CONCURRENT_EXPORTS = 4
/**
 * Policy priority constants
 */

/**
 * Degrade policy thresholds
 */

/**
 * Exporter manager defaults
 */
export const EXPORTER_MAX_BATCH_SIZE = 100_000
export const EXPORTER_MAX_BATCH_BYTES = 16 * 1024 * 1024
export const EXPORTER_MAX_CONCURRENCY = 4 // Default max concurrent exports per exporter
export const EXPORTER_HARD_MAX_CONCURRENCY = 64
export const EXPORTER_HARD_MAX_QUEUED_BATCHES = 100_000
export const EXPORTER_HARD_MAX_QUEUED_BYTES = METRICS_HARD_MAX_BUFFER_BYTES
export const METRICS_MAX_EXPORTERS = 32 // Hard fan-out ceiling per handler
export const METRICS_MAX_POLICIES = 32 // Hard policy-chain ceiling per handler
export const METRICS_MAX_EXPORT_RECORDS = 100_000 // Bounds direct exporter-manager input
export const METRICS_MAX_EXPORT_SNAPSHOT_BYTES = 16 * 1024 * 1024

/**
 * Handler and processing constants
 */
export const BATCH_CHUNK_SIZE = 1000 // Process metrics in chunks of 1000 to avoid overwhelming exporters
export const HEALTH_CHECK_BASE_DELAY_MS = 100 // Base delay for health check retries (100ms)
