export type MetricsOperationTimeoutKind =
	| 'handler-flush'
	| 'handler-shutdown'
	| 'exporter-flush'
	| 'exporter-shutdown'

/** Internal timeout identity. Never infer timeout ownership from an arbitrary error message. */
export class MetricsOperationTimeoutError extends Error {
	readonly code = 'metrics_operation_timeout'

	constructor(
		readonly operation: MetricsOperationTimeoutKind,
		message: string
	) {
		super(message)
		this.name = 'MetricsOperationTimeoutError'
	}
}

export function isMetricsOperationTimeoutError(
	error: unknown,
	operation: MetricsOperationTimeoutKind
): error is MetricsOperationTimeoutError {
	return error instanceof MetricsOperationTimeoutError && error.operation === operation
}
