type MetricsErrorReporter = (error: unknown, extra?: Record<string, string>) => void

function numericDiagnostic(value: unknown): string {
	if (typeof value !== 'number') return 'non_number'
	if (Number.isNaN(value)) return 'nan'
	if (value === Number.POSITIVE_INFINITY) return 'positive_infinity'
	if (value === Number.NEGATIVE_INFINITY) return 'negative_infinity'
	return value < 0 ? 'negative' : 'finite'
}

function reportInvalidMeasurement(
	onError: MetricsErrorReporter,
	operation: 'increment' | 'histogram' | 'gauge',
	value: unknown
): void {
	onError(new Error('metrics_invalid_measurement'), {
		metricName: 'user_metric',
		value: numericDiagnostic(value),
		operation
	})
}

export function validateCounterValue(
	_name: string,
	count: number,
	monotonic: boolean,
	onError: MetricsErrorReporter
): void {
	const countValue: unknown = count
	if (typeof countValue !== 'number' || !Number.isFinite(countValue)) {
		const error = new Error('Counter increment must be finite')
		reportInvalidMeasurement(onError, 'increment', countValue)
		throw error
	}
	if (monotonic && count < 0) {
		const error = new Error('Counter increment must be non-negative')
		reportInvalidMeasurement(onError, 'increment', count)
		throw error
	}
}

export function validateObservedValue(
	_name: string,
	value: number,
	operation: 'histogram',
	onError: MetricsErrorReporter
): void {
	const display = operation === 'histogram' ? 'Histogram' : 'Summary'
	const observedValue: unknown = value
	if (typeof observedValue === 'number' && observedValue < 0) {
		const error = new Error(`${display} observation must be non-negative`)
		reportInvalidMeasurement(onError, operation, observedValue)
		throw error
	}
	if (typeof observedValue !== 'number' || !Number.isFinite(observedValue)) {
		const error = new Error(`${display} observation must be finite`)
		reportInvalidMeasurement(onError, operation, observedValue)
		throw error
	}
}

export function validateGaugeValue(
	_name: string,
	value: number,
	onError: MetricsErrorReporter
): void {
	const gaugeValue: unknown = value
	if (typeof gaugeValue === 'number' && Number.isFinite(gaugeValue)) return
	const error = new Error('Gauge value must be finite')
	reportInvalidMeasurement(onError, 'gauge', gaugeValue)
	throw error
}
