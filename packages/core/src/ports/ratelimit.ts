import type {
	RateLimitBatchDecision,
	RateLimitCheckRequest,
	RateLimitDecision,
	RateLimitStatus
} from '../contracts/rate-limit'

/** Small application-facing rate-limit capability. */
export interface RateLimitPort {
	check(request: RateLimitCheckRequest): Promise<RateLimitDecision>
	/** Ordered and fail-fast. Successful earlier consumes are not rolled back. */
	checkMany(requests: readonly RateLimitCheckRequest[]): Promise<RateLimitBatchDecision>
}

export interface ManagedRateLimit extends RateLimitPort {
	getStatus(): RateLimitStatus
	shutdown(): Promise<void>
}

export type {
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
} from '../contracts/rate-limit'
