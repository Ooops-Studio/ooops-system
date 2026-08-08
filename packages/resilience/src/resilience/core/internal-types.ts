import type {ResilienceMetadataValue} from '@ooopsstudio/core/contracts/resilience'

export type OperationKind = 'db.read' | 'db.write' | 'db.transaction' | 'storage.upload' | 'storage.get' | 'storage.delete' | 'external.http'
export type DegradeLevel = 'NONE' | 'PARTIAL' | 'OFFLINE'
export interface ResilienceOperationContext {readonly resource: string; readonly operationKind: OperationKind; readonly tenantId?: string; readonly workspaceId?: string; readonly userId?: string; readonly correlationId?: string; readonly metadata?: Readonly<Record<string, ResilienceMetadataValue>>}
export type BackoffStrategy = 'exponential' | 'linear' | 'fixed'
export type RetryJitter = 'none' | 'full'
export interface ErrorClassificationResult {readonly isRetryable: boolean; readonly category: string; readonly delay?: number}
export type ErrorClassifier = (error: unknown) => ErrorClassificationResult
export interface RetryPolicy {readonly maxAttempts: number; readonly maxTotalTime: number; readonly backoff: BackoffStrategy; readonly initialDelay: number; readonly maxDelay: number; readonly backoffMultiplier?: number; readonly jitter?: RetryJitter; readonly errorClassifier?: ErrorClassifier; readonly maxCpuConsumption: number}
export interface CircuitBreakerConfig {readonly failureRatioThreshold: number; readonly failureCountThreshold: number; readonly timeWindow: number; readonly halfOpenTimeout: number; readonly halfOpenMaxAttempts: number; readonly halfOpenSuccessThreshold?: number}
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'
export type BulkheadOverflowStrategy = 'reject' | 'drop-oldest' | 'degrade'
export interface BulkheadConfig {readonly maxConcurrent: number; readonly maxQueueSize: number; readonly overflowStrategy: BulkheadOverflowStrategy; readonly queueTimeoutMs?: number}
export interface CoalescingConfig {readonly maxKeys: number; readonly evictionPolicy: 'LRU' | 'TTL'; readonly ttlMs: number}
export type StateIsolationScope = 'tenant' | 'workspace' | 'resource' | 'user'
export type StateIsolationKey = string
