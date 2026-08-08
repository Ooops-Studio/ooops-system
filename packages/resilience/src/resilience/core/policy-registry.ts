import type {
	ResiliencePolicyDefinition,
	ResilienceRetryPolicyDefinition
} from '@ooopsstudio/core/contracts/resilience'
import {ResilienceConfigurationError} from '@ooopsstudio/core/contracts/resilience'

import {copyDataDescriptorValues, getPlainDataDescriptors} from '../utils/data-object'

const POLICY_KEYS = new Set(['name', 'operationKind', 'timeout', 'retry', 'circuitBreaker', 'bulkhead', 'coalescing', 'fallback'])
const KINDS = new Set(['db.read', 'db.write', 'db.transaction', 'storage.upload', 'storage.get', 'storage.delete', 'external.http'])
const BUILTIN_CLASSIFIERS = new Set(['db-read', 'db-write', 'db-transaction', 'http', 'storage'])
const BUILTIN_CLASSIFIER_BY_KIND = new Map<ResiliencePolicyDefinition['operationKind'], string>([
	['db.read', 'db-read'],
	['db.write', 'db-write'],
	['db.transaction', 'db-transaction'],
	['storage.upload', 'storage'],
	['storage.get', 'storage'],
	['storage.delete', 'storage'],
	['external.http', 'http']
])
const MAX_TIMER_MS = 2_147_483_647
const MAX_RETRY_ATTEMPTS = 100
const MAX_BREAKER_RESULTS = 256
const MAX_HALF_OPEN_ATTEMPTS = 1_000
const MAX_BULKHEAD_CAPACITY = 10_000
const MAX_COALESCING_KEYS = 10_000
const MAX_RETRY_BUDGET = 1_000_000

function invalidPolicy(): never {
	throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid policy')
}

function dataDescriptors(value: unknown, maximumFields: number): PropertyDescriptorMap {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalidPolicy()
	const descriptors = getPlainDataDescriptors(value, maximumFields)
	if (!descriptors) {
		invalidPolicy()
	}
	return descriptors
}

function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
	const descriptors = dataDescriptors(value, keys.length)
	if (Object.keys(descriptors).some((key) => !keys.includes(key))) {
		invalidPolicy()
	}
	return copyDataDescriptorValues(descriptors)
}

function positive(value: unknown, integer = true, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum || (integer && !Number.isSafeInteger(value))) {
		invalidPolicy()
	}
	return value
}

function snapshotRetry(value: unknown, customClassifiers: ReadonlySet<string>): ResilienceRetryPolicyDefinition | false | undefined {
	if (value === undefined || value === false) return value
	const raw = closedObject(value, ['classifier', 'maxAttempts', 'maxTotalTimeMs', 'initialDelayMs', 'maxDelayMs', 'multiplier', 'jitter', 'budget'])
	if (typeof raw.classifier !== 'string' || (!BUILTIN_CLASSIFIERS.has(raw.classifier) && !customClassifiers.has(raw.classifier))) {
		throw new ResilienceConfigurationError('RESILIENCE_UNKNOWN_CLASSIFIER', 'invalid policy')
	}
	const maxAttempts = positive(raw.maxAttempts, true, MAX_RETRY_ATTEMPTS)
	const maxTotalTimeMs = positive(raw.maxTotalTimeMs, true, MAX_TIMER_MS)
	const initialDelayMs = positive(raw.initialDelayMs, true, MAX_TIMER_MS)
	const maxDelayMs = positive(raw.maxDelayMs, true, MAX_TIMER_MS)
	const multiplier = positive(raw.multiplier, false)
	if (initialDelayMs > maxDelayMs || !['full', 'equal', 'none'].includes(raw.jitter as string)) {
		invalidPolicy()
	}
	let budget: {maxRetries: number; windowMs: number} | undefined
	if (raw.budget !== undefined) {
		const candidate = closedObject(raw.budget, ['maxRetries', 'windowMs'])
		budget = Object.freeze({maxRetries: positive(candidate.maxRetries, true, MAX_RETRY_BUDGET), windowMs: positive(candidate.windowMs, true, MAX_TIMER_MS)})
	}
	return Object.freeze({classifier: raw.classifier, maxAttempts, maxTotalTimeMs, initialDelayMs, maxDelayMs, multiplier, jitter: raw.jitter as 'full' | 'equal' | 'none', ...(budget ? {budget} : {})})
}

export function createPolicyRegistry(
	policies: readonly ResiliencePolicyDefinition[],
	customClassifiers: ReadonlySet<string> = new Set(),
	customFallbacks: ReadonlySet<string> = new Set()
): ReadonlyMap<string, ResiliencePolicyDefinition> {
	const lengthDescriptor = Array.isArray(policies) ? Object.getOwnPropertyDescriptor(policies, 'length') : undefined
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > 256) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid policies')
	const registry = new Map<string, ResiliencePolicyDefinition>()
	for (let index = 0; index < length; index++) {
		const item = Object.getOwnPropertyDescriptor(policies, String(index))
		if (!item?.enumerable || !('value' in item)) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid policies')
		const policy = item.value
		const raw = closedObject(policy, [...POLICY_KEYS])
		if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 128 || registry.has(raw.name)) {
			throw new ResilienceConfigurationError('RESILIENCE_INVALID_POLICY_NAME', 'invalid policy')
		}
		if (!KINDS.has(raw.operationKind as string)) invalidPolicy()
		const timeout = closedObject(raw.timeout, ['defaultMs', 'maxMs'])
		const defaultMs = positive(timeout.defaultMs, true, MAX_TIMER_MS)
		const maxMs = timeout.maxMs === undefined ? defaultMs : positive(timeout.maxMs, true, MAX_TIMER_MS)
		if (defaultMs > maxMs) invalidPolicy()
		const retry = snapshotRetry(raw.retry, customClassifiers)
		if (retry && BUILTIN_CLASSIFIERS.has(retry.classifier) &&
			retry.classifier !== BUILTIN_CLASSIFIER_BY_KIND.get(raw.operationKind as ResiliencePolicyDefinition['operationKind'])) {
			invalidPolicy()
		}
		const circuitBreaker = raw.circuitBreaker === undefined || raw.circuitBreaker === false ? raw.circuitBreaker : (() => {
			const value = closedObject(raw.circuitBreaker, ['failureRatioThreshold', 'failureCountThreshold', 'timeWindowMs', 'halfOpenAfterMs', 'halfOpenMaxAttempts'])
			if (typeof value.failureRatioThreshold !== 'number' || !Number.isFinite(value.failureRatioThreshold) || value.failureRatioThreshold <= 0 || value.failureRatioThreshold > 1) invalidPolicy()
			return Object.freeze({failureRatioThreshold: value.failureRatioThreshold, failureCountThreshold: positive(value.failureCountThreshold, true, MAX_BREAKER_RESULTS), timeWindowMs: positive(value.timeWindowMs, true, MAX_TIMER_MS), halfOpenAfterMs: positive(value.halfOpenAfterMs, true, MAX_TIMER_MS), halfOpenMaxAttempts: positive(value.halfOpenMaxAttempts, true, MAX_HALF_OPEN_ATTEMPTS)})
		})()
		const bulkhead = raw.bulkhead === undefined || raw.bulkhead === false ? raw.bulkhead : (() => {
			const value = closedObject(raw.bulkhead, ['maxConcurrent', 'maxQueueSize', 'queueTimeoutMs'])
			const maxQueueSize = typeof value.maxQueueSize === 'number' && Number.isSafeInteger(value.maxQueueSize) && value.maxQueueSize >= 0 && value.maxQueueSize <= MAX_BULKHEAD_CAPACITY ? value.maxQueueSize : -1
			if (maxQueueSize < 0) invalidPolicy()
			return Object.freeze({maxConcurrent: positive(value.maxConcurrent, true, MAX_BULKHEAD_CAPACITY), maxQueueSize, queueTimeoutMs: positive(value.queueTimeoutMs, true, MAX_TIMER_MS)})
		})()
		const coalescing = raw.coalescing === undefined || raw.coalescing === false ? raw.coalescing : (() => {
			const value = closedObject(raw.coalescing, ['maxKeys', 'ttlMs'])
			return Object.freeze({maxKeys: positive(value.maxKeys, true, MAX_COALESCING_KEYS), ttlMs: positive(value.ttlMs, true, MAX_TIMER_MS)})
		})()
		if (raw.fallback !== undefined && (typeof raw.fallback !== 'string' || !customFallbacks.has(raw.fallback))) {
			throw new ResilienceConfigurationError('RESILIENCE_UNKNOWN_FALLBACK', 'invalid policy')
		}
		registry.set(raw.name, Object.freeze({name: raw.name, operationKind: raw.operationKind as ResiliencePolicyDefinition['operationKind'], timeout: Object.freeze({defaultMs, maxMs}), ...(retry !== undefined ? {retry} : {}), ...(circuitBreaker !== undefined ? {circuitBreaker} : {}), ...(bulkhead !== undefined ? {bulkhead} : {}), ...(coalescing !== undefined ? {coalescing} : {}), ...(raw.fallback ? {fallback: raw.fallback as string} : {})}))
	}
	return registry
}
