import {createProductionResilience} from '../../../../src/resilience/public/production'

const runtime = createProductionResilience({
	policies: [{
		name: 'child.retry', operationKind: 'external.http', timeout: {defaultMs: 2_000},
		retry: {classifier: 'http', maxAttempts: 2, maxTotalTimeMs: 1_000, initialDelayMs: 75, maxDelayMs: 75, multiplier: 1, jitter: 'none'},
		circuitBreaker: false
	}]
})
let attempts = 0
const result = await runtime.execute({operation: 'child', policy: 'child.retry', context: {resource: 'child.remote'}}, async() => {
	attempts++
	if (attempts === 1) throw Object.assign(new Error('retry'), {status: 429, retryAfter: '0.001'})
	return 'ok'
})
await runtime.shutdown()
console.log(`OOOPS_RESILIENCE_CHILD=${JSON.stringify({result, attempts, state: runtime.getStatus().state})}`)
