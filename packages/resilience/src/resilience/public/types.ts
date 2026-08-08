import type {
	FallbackStrategy,
	ResilienceErrorClassifier,
	ResiliencePolicyDefinition,
	ResilienceStatus
} from '@ooopsstudio/core/contracts/resilience'
import type {ResiliencePort} from '@ooopsstudio/core/ports/resilience'

export interface ManagedResilience extends ResiliencePort {
	getStatus(): ResilienceStatus
	shutdown(): Promise<void>
}

export type ResilienceFallbackRegistry = Readonly<Record<string, readonly FallbackStrategy[]>>
export type ResilienceClassifierRegistry = Readonly<Record<string, ResilienceErrorClassifier>>

export type {
	ResilienceOperationKind,
	ResilienceRetryClassifier,
	ResilienceRuntimeState,
	ResilienceStatus,
	ResilienceMetadataValue,
	ResilienceExecutionContext,
	ResilienceExecutionRequest,
	ResilienceRetryPolicyDefinition,
	ResilienceCircuitBreakerPolicyDefinition,
	ResilienceBulkheadPolicyDefinition,
	ResilienceCoalescingPolicyDefinition,
	ResiliencePolicyDefinition,
	ResilienceClassificationResult,
	ResilienceErrorClassifier,
	FallbackStrategy
} from '@ooopsstudio/core/contracts/resilience'

export {
	ResilienceError,
	TimedOutError,
	BreakerOpenError,
	BulkheadOverflowError,
	RetryExhaustedError,
	ResilienceConfigurationError
} from '@ooopsstudio/core/contracts/resilience'

export type {ResiliencePort, ResilienceOperation} from '@ooopsstudio/core/ports/resilience'

export interface ResilienceRuntimeConfiguration {
	readonly policies: readonly ResiliencePolicyDefinition[]
	readonly classifiers?: ResilienceClassifierRegistry
	readonly fallbacks?: ResilienceFallbackRegistry
}
