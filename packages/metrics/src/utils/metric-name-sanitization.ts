const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const MAX_NAME_LENGTH = 1_024

export interface MetricNameValidation {
	readonly valid: boolean
	readonly error?: string
}

export function validateMetricName(name: string): MetricNameValidation {
	if (typeof name !== 'string') return {valid: false, error: 'Metric name must be a string'}
	if (name.length > MAX_NAME_LENGTH) return {valid: false, error: 'Metric name must not exceed 1024 characters'}
	if (!METRIC_NAME_PATTERN.test(name)) return {
		valid: false,
		error: `Metric name "${name}" contains invalid characters. Must match pattern: [a-zA-Z_:][a-zA-Z0-9_:]*`
	}
	return {valid: true}
}

function assertBoundedName(name: string): void {
	if (typeof name !== 'string') throw new TypeError('Metric and label names must be strings')
	if (name.length > MAX_NAME_LENGTH) throw new TypeError('Metric and label names must not exceed 1024 characters')
}

export function sanitizeMetricName(name: string): string {
	assertBoundedName(name)
	let sanitized = name.replace(/[^a-zA-Z0-9_:]/g, '_')
	if (!/^[a-zA-Z_:]/.test(sanitized)) sanitized = `_${sanitized}`
	return sanitized
}

export function sanitizeLabelName(name: string): string {
	assertBoundedName(name)
	// Prometheus label names deliberately use a narrower grammar than metric
	// names: ':' is reserved for metric names and makes a label token invalid.
	let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_')
	if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = `_${sanitized}`
	return sanitized
}
