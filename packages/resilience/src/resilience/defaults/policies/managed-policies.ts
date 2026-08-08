import type {ResiliencePolicyDefinition} from '@ooopsstudio/core/contracts/resilience'
import {snapshotBoundedDataGraph} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {getPlainDataDescriptors} from '../../utils/data-object'

const breaker = Object.freeze({
	failureRatioThreshold: 0.5,
	failureCountThreshold: 10,
	timeWindowMs: 60_000,
	halfOpenAfterMs: 30_000,
	halfOpenMaxAttempts: 3
})

const retry = (
	classifier: 'db-read' | 'db-write' | 'db-transaction' | 'http' | 'storage',
	maxAttempts: number,
	maxTotalTimeMs: number,
	initialDelayMs: number,
	maxDelayMs: number
) => Object.freeze({classifier, maxAttempts, maxTotalTimeMs, initialDelayMs, maxDelayMs, multiplier: 2, jitter: 'full' as const, budget: Object.freeze({maxRetries: 1_000, windowMs: 60_000})})

const policy = (
	name: ResiliencePolicyDefinition['operationKind'],
	classifier: Parameters<typeof retry>[0],
	maxAttempts: number,
	defaultMs: number,
	initialDelayMs: number,
	maxDelayMs: number
) => ({name, operationKind: name, timeout: {defaultMs}, retry: retry(classifier, maxAttempts, defaultMs, initialDelayMs, maxDelayMs), circuitBreaker: breaker})

const BUILTIN_POLICY_INPUT = [
	policy('db.read', 'db-read', 3, 2_000, 50, 500),
	policy('db.write', 'db-write', 2, 3_000, 100, 1_000),
	policy('db.transaction', 'db-transaction', 3, 5_000, 100, 2_000),
	policy('storage.upload', 'storage', 5, 30_000, 200, 5_000),
	policy('storage.get', 'storage', 3, 5_000, 100, 2_000),
	policy('storage.delete', 'storage', 3, 5_000, 100, 2_000),
	policy('external.http', 'http', 3, 10_000, 200, 3_000)
] satisfies ResiliencePolicyDefinition[]

export const BUILTIN_RESILIENCE_POLICIES: readonly ResiliencePolicyDefinition[] = Object.freeze(
	BUILTIN_POLICY_INPUT.map((policy) => Object.freeze({...policy, timeout: Object.freeze(policy.timeout)}))
)

export function mergeBuiltinPolicies(additional: readonly ResiliencePolicyDefinition[] = []): readonly ResiliencePolicyDefinition[] {
	if (!Array.isArray(additional)) throw new TypeError('Invalid policies')
	let captured: readonly ResiliencePolicyDefinition[]
	try { captured = snapshotBoundedDataGraph(additional) as readonly ResiliencePolicyDefinition[] }
	catch { throw new TypeError('Invalid policies') }
	const lengthDescriptor = Object.getOwnPropertyDescriptor(captured, 'length')
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > 256) throw new TypeError('Invalid policies')
	const snapshot: ResiliencePolicyDefinition[] = []
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(captured, String(index))
		if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Invalid policies')
		snapshot.push(descriptor.value as ResiliencePolicyDefinition)
	}
	const names = new Set(snapshot.map((policy) => {
		const policyDescriptors = getPlainDataDescriptors(policy, 8)
		if (!policyDescriptors) throw new TypeError('Invalid policies')
		if (!policyDescriptors.name?.enumerable || !('value' in policyDescriptors.name) || typeof policyDescriptors.name.value !== 'string') {
			throw new TypeError('Invalid policies')
		}
		return policyDescriptors.name.value
	}))
	return Object.freeze([...BUILTIN_RESILIENCE_POLICIES.filter((policy) => !names.has(policy.name)), ...snapshot])
}
