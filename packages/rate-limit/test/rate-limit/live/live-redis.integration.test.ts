import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {createProductionRateLimit} from '../../../src/rate-limit/public/production'

import {LiveRedisPort} from './_helpers/live-redis-port'

const redisUrl = process.env.OOOPS_TEST_REDIS_URL ?? process.env.REDIS_URL

describe.runIf(Boolean(redisUrl))('simplified rate-limit live Redis integration', () => {
	let redis: LiveRedisPort
	const namespaces: string[] = []

	beforeAll(async() => {
		redis = await LiveRedisPort.connect(redisUrl!)
		expect(await redis.ping()).toBe(true)
	})

	afterAll(async() => {
		for (const namespace of namespaces) await redis.deletePattern(`*${namespace}*`)
		await redis.close()
	})

	const namespace = (label: string): string => {
		const value = `rate-limit-${label}-${process.pid}-${Date.now()}-${namespaces.length}`
		namespaces.push(value)
		return value
	}

	it('atomically enforces fixed-window quotas across concurrent consumers', async() => {
		const runtime = createProductionRateLimit({
			redis,
			namespace: namespace('fixed'),
			onBackendError: 'block',
			policies: [{name: 'api.user', partition: 'keyed', limit: 5, windowMs: 60_000}]
		})
		const decisions = await Promise.all(Array.from({length: 20}, async() =>
			await runtime.check({policy: 'api.user', key: 'same-user'})))
		expect(decisions.filter(({allowed}) => allowed)).toHaveLength(5)
		expect(decisions.filter(({allowed}) => !allowed)).toHaveLength(15)
		await runtime.shutdown()
	})

	it('atomically enforces integer token-bucket costs', async() => {
		const runtime = createProductionRateLimit({
			redis,
			namespace: namespace('token'),
			onBackendError: 'block',
			policies: [{
				name: 'ai.provider', partition: 'keyed', algorithm: 'token-bucket',
				limit: 4, capacity: 4, windowMs: 60_000, maxCost: 2
			}]
		})
		const decisions = await Promise.all(Array.from({length: 6}, async() =>
			await runtime.check({policy: 'ai.provider', key: 'same-provider', cost: 2})))
		expect(decisions.filter(({allowed}) => allowed)).toHaveLength(2)
		expect(decisions.filter(({allowed}) => !allowed)).toHaveLength(4)
		await runtime.shutdown()
	})

	it('retains the fixed-window cursor for a rollback-extended counter lifetime', async() => {
		const clock = createFixedClock(1_000)
		const runtime = createProductionRateLimit({
			redis,
			namespace: namespace('fixed-rollback'),
			onBackendError: 'block',
			policies: [{name: 'api.user', partition: 'keyed', limit: 1, windowMs: 200}],
			clock
		})
		expect(await runtime.check({policy: 'api.user', key: 'same-user'})).toMatchObject({allowed: true})
		clock.set(0)
		expect(await runtime.check({policy: 'api.user', key: 'same-user'})).toMatchObject({allowed: false})
		await new Promise((resolve) => setTimeout(resolve, 250))
		expect(await runtime.check({policy: 'api.user', key: 'same-user'})).toMatchObject({allowed: false})
		await runtime.shutdown()
	})
})
