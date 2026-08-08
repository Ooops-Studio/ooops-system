import {runInNewContext} from 'node:vm'

import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {TOK} from '@ooopsstudio/core/tokens'

import {registerResilience} from '../../../../src/resilience'
import {classifyBuiltinResilienceError} from '../../../../src/resilience/core/classifiers'
import {createFallbackManager} from '../../../../src/resilience/core/fallback-manager'
import {createRetryEngine} from '../../../../src/resilience/core/retry-engine'
import {createTimeoutEngine} from '../../../../src/resilience/core/timeout'
import {createCustomResilience} from '../../../../src/resilience/public/custom'

const unhandled: string[] = []
process.on('unhandledRejection', (error) => { unhandled.push(error instanceof Error ? error.message : String(error)) })
const rejectingBoolean = (() => runInNewContext(
	'Promise.reject(error)',
	{error: new Error('unexpected cross-realm async callback')}
)) as never

const retryDefinition = {
	classifier: 'async-classifier', maxAttempts: 2, maxTotalTimeMs: 100,
	initialDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitter: 'none' as const
}
const runtime = createCustomResilience({
	clock: createFixedClock(0),
	classifiers: {'async-classifier': rejectingBoolean},
	fallbacks: {'async-fallback': [{condition: rejectingBoolean, handler: () => 'unused', degradeLevel: 'PARTIAL'}]},
	policies: [
		{name: 'child.classifier', operationKind: 'external.http', timeout: {defaultMs: 100}, retry: retryDefinition, circuitBreaker: false},
		{name: 'child.fallback', operationKind: 'external.http', timeout: {defaultMs: 100}, retry: false, circuitBreaker: false, fallback: 'async-fallback'}
	]
})

for (const policy of ['child.classifier', 'child.fallback']) {
	try {
		await runtime.execute({operation: policy, policy, context: {resource: 'child.callback'}}, async() => {
			throw new Error('primary')
		})
	} catch { /* expected primary failure */ }
}
await runtime.shutdown()

const retry = createRetryEngine({
	clock: createFixedClock(0),
	policy: {
		maxAttempts: 2, maxTotalTime: 100, backoff: 'fixed', initialDelay: 1,
		maxDelay: 1, maxCpuConsumption: 10, errorClassifier: rejectingBoolean
	}
})
const retryAllowed = retry.shouldRetry(new Error('standalone')).shouldRetry
const fallback = createFallbackManager({
	strategies: [{condition: rejectingBoolean, handler: () => 'unused', degradeLevel: 'PARTIAL'}]
})
const fallbackUsed = (await fallback.tryFallback(new Error('standalone'), {
	resource: 'child.callback', operationKind: 'external.http'
})).used

const asyncRandom = (async() => { throw new Error('unexpected async random') }) as never
const jitterRetry = createRetryEngine({
	clock: createFixedClock(0), random: asyncRandom,
	policy: {maxAttempts: 2, maxTotalTime: 100, backoff: 'fixed', initialDelay: 1, maxDelay: 1, maxCpuConsumption: 10}
})
const jitterAllowed = jitterRetry.shouldRetry(new Error('standalone')).shouldRetry
let invalidClockRejected = false
try {
	createRetryEngine({
		clock: {now: async() => { throw new Error('unexpected async clock') }} as never,
		policy: {maxAttempts: 1, maxTotalTime: 100, backoff: 'fixed', initialDelay: 1, maxDelay: 1, maxCpuConsumption: 10}
	})
} catch { invalidClockRejected = true }
classifyBuiltinResilienceError('http', {
	status: 429,
	headers: {get: async() => { throw new Error('unexpected async header') }}
}, 0)

let invalidContainerRejected = false
try {
	await registerResilience({
		has: async() => { throw new Error('unexpected async has') },
		get: (token: symbol) => token === TOK.Clock ? createFixedClock(0) : undefined,
		tryGet: () => undefined,
		bind: () => undefined,
		unbind: () => true
	} as never, {preset: 'production'})
} catch { invalidContainerRejected = true }

const timeout = createTimeoutEngine({clock: createFixedClock(0)})
const timeoutResult = await timeout.withTimeout(async() => 'timeout-result', 100, {
	resource: 'child.callback', operationKind: 'external.http'
}, {
	onOperationSettled: async() => { throw new Error('unexpected async ownership observer') }
})

await new Promise<void>((resolve) => setImmediate(resolve))
console.log(`OOOPS_RESILIENCE_SYNC_CALLBACK=${JSON.stringify({retryAllowed, fallbackUsed, jitterAllowed, invalidClockRejected, invalidContainerRejected, timeoutResult, unhandled})}`)
if (retryAllowed || fallbackUsed || !jitterAllowed || !invalidClockRejected || !invalidContainerRejected || timeoutResult !== 'timeout-result' || unhandled.length > 0) process.exitCode = 1
