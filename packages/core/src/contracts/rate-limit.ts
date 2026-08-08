/** Immutable rate-limit policy and decision contracts. */

export type RateLimitAlgorithm = 'fixed-window' | 'token-bucket'
export type RateLimitMode = 'enforce' | 'shadow'
export type RateLimitPartition = 'global' | 'keyed'
export type BackendErrorPolicy = 'allow' | 'block'

export interface RateLimitPolicyDefinition {
	readonly name: string
	readonly partition: RateLimitPartition
	readonly algorithm?: RateLimitAlgorithm
	readonly limit: number
	readonly windowMs: number
	readonly defaultCost?: number
	readonly maxCost?: number
	/** Optional token-bucket burst capacity. Invalid for fixed-window policies. */
	readonly capacity?: number
	readonly mode?: RateLimitMode
}

export interface RateLimitCheckRequest {
	readonly policy: string
	/** Required by keyed policies and rejected by global policies. */
	readonly key?: string
	readonly cost?: number
}

export type RateLimitDecisionReason =
	| 'allowed'
	| 'limit_exceeded'
	| 'shadow'
	| 'backend_unavailable'

export interface RateLimitDecision {
	readonly allowed: boolean
	readonly policy: string
	readonly limit: number
	readonly remaining: number
	readonly resetAt: number | null
	readonly retryAfterMs: number | null
	readonly reason: RateLimitDecisionReason
}

export interface RateLimitBatchDecision {
	readonly allowed: boolean
	readonly decisions: readonly RateLimitDecision[]
	readonly blockedBy?: string
}

export type RateLimitRuntimeState = 'running' | 'draining' | 'closed'
export type RateLimitBackendState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface RateLimitStatus {
	readonly state: RateLimitRuntimeState
	readonly backendState: RateLimitBackendState
	readonly activeOperations: number
	readonly rejectedTotal: number
	readonly backendFailuresTotal: number
	readonly lastFailureCode?: string
}
