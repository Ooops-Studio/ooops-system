/**
 * @file Metrics capability boundary (DI port).
 * Minimal metrics port interface for counters and measurements.
 */

/**
 * Minimal metrics port interface for counters and measurements
 */
export interface MetricsPort {

	/**
	 * Increment a counter metric
	 * @param name - Metric name
	 * @param tags - Optional tags for filtering/grouping
	 * @param count - Optional count to increment by (default: 1). Enables batched increments.
	 */
	increment?(name: string, tags?: Record<string, string>, count?: number): void

	/** Record a value metric (gauge, histogram, etc.) */
	record?(name: string, value: number, tags?: Record<string, string>): void
}
