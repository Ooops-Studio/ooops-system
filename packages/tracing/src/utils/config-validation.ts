/**
 * @file Configuration validation for tracing service.
 * Validates sampling ratios, limits, retry policies, and resilience configs.
 */
import * as validation from '@ooopsstudio/core/utils/validation'

import {captureCapability} from './capabilities'

interface RetryPolicyShape {
	maxAttempts: number
	baseDelayMs: number
	multiplier: number
	maxDelayMs: number
	jitter: number
	attemptTimeoutMs: number
}

interface TracerOptionsShape {
	clock: unknown
	contextStore: unknown
	idGen: unknown
	sampler: unknown
	processor: unknown
	limits?: {
		maxAttributesPerSpan?: number
		maxEventsPerSpan?: number
		maxAttrBytes?: number
	}
}
/**
 * Validate sampling ratio.
 * Must be between 0 and 1 (inclusive).
 */
export function validateSamplingRatio(ratio: number): asserts ratio is number {
	validation.validateFiniteNumber(ratio, 'Sampling ratio')
	validation.validateNumberInRange(ratio, 'Sampling ratio', 0, 1)
}
/**
 * Validate span limits.
 * All limits must be positive integers.
 */
export function validateLimits(limits: {
	maxAttributesPerSpan?: number
	maxEventsPerSpan?: number
	maxAttrBytes?: number
}): void {
	if (limits.maxAttributesPerSpan !== undefined) {
		validation.validateNonNegativeInteger(limits.maxAttributesPerSpan, 'maxAttributesPerSpan')
		if (limits.maxAttributesPerSpan > 10_000) throw new Error('maxAttributesPerSpan must be <= 10000')
	}
	if (limits.maxEventsPerSpan !== undefined) {
		validation.validateNonNegativeInteger(limits.maxEventsPerSpan, 'maxEventsPerSpan')
		if (limits.maxEventsPerSpan > 10_000) throw new Error('maxEventsPerSpan must be <= 10000')
	}
	if (limits.maxAttrBytes !== undefined) {
		validation.validateNonNegativeInteger(limits.maxAttrBytes, 'maxAttrBytes')
		if (limits.maxAttrBytes > 10_000_000) throw new Error('maxAttrBytes must be <= 10000000')
	}
}
/**
 * Validate retry policy.
 */
export function validateRetryPolicy(policy: RetryPolicyShape): void {
	validation.validatePositiveInteger(policy.maxAttempts, 'Retry maxAttempts')
	if (policy.maxAttempts > 10) throw new Error(`Retry maxAttempts must be <= 10, got ${policy.maxAttempts}`)
	validation.validateNonNegativeFinite(policy.baseDelayMs, 'Retry baseDelayMs')
	if (policy.baseDelayMs > 2_147_483_647) throw new Error(`Retry baseDelayMs must be <= 2147483647, got ${policy.baseDelayMs}`)
	validation.validatePositiveFinite(policy.multiplier, 'Retry multiplier')
	// Multiplier must be >= 1 (exponential backoff requires multiplier >= 1)
	if (policy.multiplier < 1) {
		throw new Error(`Retry multiplier must be >= 1, got ${policy.multiplier}`)
	}
	validation.validateNonNegativeFinite(policy.maxDelayMs, 'Retry maxDelayMs')
	if (policy.maxDelayMs > 2_147_483_647) throw new Error(`Retry maxDelayMs must be <= 2147483647, got ${policy.maxDelayMs}`)
	if (policy.maxDelayMs < policy.baseDelayMs) {
		throw new Error(`Retry maxDelayMs (${policy.maxDelayMs}) must be >= baseDelayMs (${policy.baseDelayMs})`)
	}
	validation.validateNumberInRange(policy.jitter, 'Retry jitter', 0, 1)
	validation.validateNonNegativeFinite(policy.attemptTimeoutMs, 'Retry attemptTimeoutMs')
	if (policy.attemptTimeoutMs > 2_147_483_647) throw new Error(`Retry attemptTimeoutMs must be <= 2147483647, got ${policy.attemptTimeoutMs}`)
}
/**
 * Validate resilience configuration.
 */
export function validateResilienceConfig(config: {
	tokenBucketRate: number
	tokenBucketBurst: number
	breakerThreshold: number
	breakerHalfOpenTimeout: number
}): void {
	validation.validateNonNegativeFinite(config.tokenBucketRate, 'Token bucket rate')
	if (config.tokenBucketRate > 1_000_000) throw new Error(`Token bucket rate must be <= 1000000, got ${config.tokenBucketRate}`)
	validation.validatePositiveInteger(config.tokenBucketBurst, 'Token bucket burst')
	if (config.tokenBucketBurst > 1_000_000) throw new Error(`Token bucket burst must be <= 1000000, got ${config.tokenBucketBurst}`)
	validation.validatePositiveInteger(config.breakerThreshold, 'Circuit breaker threshold')
	if (config.breakerThreshold > 10_000) throw new Error(`Circuit breaker threshold must be <= 10000, got ${config.breakerThreshold}`)
	validation.validateNonNegativeFinite(config.breakerHalfOpenTimeout, 'Circuit breaker half-open timeout')
	if (config.breakerHalfOpenTimeout > 2_147_483_647) throw new Error(`Circuit breaker half-open timeout must be <= 2147483647, got ${config.breakerHalfOpenTimeout}`)
}
/**
 * Validate tracer options.
 * Main validation entry point.
 */
export function validateTracerOptions(options: TracerOptionsShape): void {
	if (!options || !captureCapability(options.clock, 'now')) throw new Error('Tracing clock must provide now()')
	if (!captureCapability(options.contextStore, 'get') || !captureCapability(options.contextStore, 'run')) throw new Error('Tracing contextStore must provide get() and run()')
	if (!captureCapability(options.idGen, 'nextTraceId') || !captureCapability(options.idGen, 'nextSpanId')) throw new Error('Tracing idGen must provide ID generators')
	if (!captureCapability(options.sampler, 'decide')) throw new Error('Tracing sampler must provide decide()')
	if (!captureCapability(options.processor, 'onEnd') || !captureCapability(options.processor, 'flush') || !captureCapability(options.processor, 'shutdown')) throw new Error('Tracing processor is invalid')
	// Validate limits if provided
	if (options.limits) {
		validateLimits(options.limits)
	}
}
