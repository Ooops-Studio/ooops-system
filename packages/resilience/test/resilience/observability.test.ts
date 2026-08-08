import type {ResiliencePolicyDefinition} from '@ooopsstudio/core/contracts/resilience'
import {describe, expect, it, vi} from 'vitest'

import {attachResilienceObservability} from '../../src/resilience/public/observability'
import {createProductionResilience} from '../../src/resilience/public/production'

const policy: ResiliencePolicyDefinition = {
	name: 'observed',
	operationKind: 'external.http',
	timeout: {defaultMs: 100},
	retry: false,
	circuitBreaker: false,
	bulkhead: false,
	coalescing: false
}

describe('resilience observability', () => {
	it('delivers frozen bounded events without exposing request data', async() => {
		const runtime = createProductionResilience({clock: {now: () => Date.now()}, policies: [policy]})
		const events: object[] = []
		const detach = attachResilienceObservability(runtime, (event) => { events.push(event) })

		await runtime.execute({
			operation: 'secret-operation',
			policy: 'observed',
			context: {resource: 'secret-resource', metadata: {token: 'secret-token'}}
		}, async() => 'ok')

		expect(events).toContainEqual({kind: 'execution', result: 'success'})
		expect(events.every(Object.isFrozen)).toBe(true)
		expect(JSON.stringify(events)).not.toContain('secret')
		detach()
		await runtime.shutdown()
	})

	it('allows one attachment, isolates listener failures, and disposes idempotently', async() => {
		const runtime = createProductionResilience({clock: {now: () => Date.now()}, policies: [policy]})
		const listener = vi.fn(() => { throw new Error('observer failed') })
		const detach = attachResilienceObservability(runtime, listener)
		expect(() => attachResilienceObservability(runtime, () => undefined)).toThrow(/already attached/u)

		await expect(runtime.execute({operation: 'safe', policy: 'observed', context: {resource: 'safe'}}, async() => 1))
			.resolves.toBe(1)
		detach()
		detach()
		await runtime.shutdown()
	})

	it('rejects attachment to unmanaged runtimes', () => {
		expect(() => attachResilienceObservability({} as never, () => undefined)).toThrow(/unavailable/u)
	})
})
