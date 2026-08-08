import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'

export interface ObservabilityDestinations {
	readonly logger?: Logging
	readonly errors?: Errors
	readonly metrics?: MetricsPort
	readonly tracer?: Tracing
}
