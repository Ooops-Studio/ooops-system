export type ResilienceOperationKind =
	| 'db.read'
	| 'db.write'
	| 'db.transaction'
	| 'storage.upload'
	| 'storage.get'
	| 'storage.delete'
	| 'external.http'

export type ResilienceRetryClassifier =
	| 'db-read'
	| 'db-write'
	| 'db-transaction'
	| 'http'
	| 'storage'

export type ResilienceRuntimeState = 'running' | 'draining' | 'closed'

export interface ResilienceStatus {
	readonly state: ResilienceRuntimeState
	readonly activeOperations: number
	readonly queuedOperations: number
	readonly retriedTotal: number
	readonly rejectedTotal: number
	readonly lastFailureCode?: string
}

export type ResilienceMetadataValue = string | number | boolean

export interface ResilienceExecutionContext {
	readonly resource: string
	readonly tenantId?: string
	readonly workspaceId?: string
	readonly userId?: string
	readonly correlationId?: string
	readonly metadata?: Readonly<Record<string, ResilienceMetadataValue>>
}

export interface ResilienceExecutionRequest {
	readonly operation: string
	readonly policy: string
	readonly context: ResilienceExecutionContext
	readonly timeoutMs?: number
	readonly coalescingKey?: string
}

export interface ResilienceRetryPolicyDefinition {
	readonly classifier: ResilienceRetryClassifier | string
	readonly maxAttempts: number
	readonly maxTotalTimeMs: number
	readonly initialDelayMs: number
	readonly maxDelayMs: number
	readonly multiplier: number
	readonly jitter: 'full' | 'equal' | 'none'
	readonly budget?: {readonly maxRetries: number; readonly windowMs: number}
}

export interface ResilienceCircuitBreakerPolicyDefinition {
	readonly failureRatioThreshold: number
	readonly failureCountThreshold: number
	readonly timeWindowMs: number
	readonly halfOpenAfterMs: number
	readonly halfOpenMaxAttempts: number
}

export interface ResilienceBulkheadPolicyDefinition {
	readonly maxConcurrent: number
	readonly maxQueueSize: number
	readonly queueTimeoutMs: number
}

export interface ResilienceCoalescingPolicyDefinition {
	readonly maxKeys: number
	readonly ttlMs: number
}

export interface ResiliencePolicyDefinition {
	readonly name: string
	readonly operationKind: ResilienceOperationKind
	readonly timeout: {readonly defaultMs: number; readonly maxMs?: number}
	readonly retry?: false | ResilienceRetryPolicyDefinition
	readonly circuitBreaker?: false | ResilienceCircuitBreakerPolicyDefinition
	readonly bulkhead?: false | ResilienceBulkheadPolicyDefinition
	readonly coalescing?: false | ResilienceCoalescingPolicyDefinition
	/** Custom preset only: references a bootstrap fallback registry entry. */
	readonly fallback?: string
}

export interface ResilienceClassificationResult {
	readonly retryable: boolean
	readonly delayMs?: number
	readonly ambiguousCompletion?: boolean
}

export type ResilienceErrorClassifier = (error: unknown) => ResilienceClassificationResult

export interface FallbackStrategy<T = unknown> {
	readonly condition: (error: unknown) => boolean
	readonly handler: (error: unknown) => T | Promise<T>
	readonly degradeLevel: 'NONE' | 'PARTIAL' | 'OFFLINE'
}
