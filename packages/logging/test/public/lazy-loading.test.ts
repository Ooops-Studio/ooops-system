import {describe, expect, it, vi} from 'vitest'

const loads = vi.hoisted(() => ({remote: 0, http: 0, loki: 0}))

vi.mock('../../src/public/production-remote-transferring', () => {
	loads.remote += 1
	return {
		createProductionRemoteTransferring: vi.fn(async() => ({
			write: vi.fn(),
			flush: vi.fn(async() => {}),
			close: vi.fn(async() => {}),
			telemetry: vi.fn(() => ({
				queueSize: 0,
				droppedTotal: 0,
				retriedTotal: 0,
				sinkState: 'healthy'
			}))
		}))
	}
})

vi.mock('../../src/sinks/providers/http', () => {
	loads.http += 1
	return {createHttpLoggingSink: vi.fn(() => ({write: vi.fn()}))}
})

vi.mock('../../src/sinks/providers/loki', () => {
	loads.loki += 1
	return {createLokiLoggingSink: vi.fn(() => ({write: vi.fn()}))}
})

import {createProductionTransferring} from '../../src/public/production-transferring'
import {createLoggingSink} from '../../src/sinks'

describe('logging lazy runtime loading', () => {
	it('does not evaluate remote delivery for stdout-only production logging', async() => {
		const transferring = await createProductionTransferring({now: () => 1_000}, undefined)

		expect(loads.remote).toBe(0)
		await transferring.close()
	})

	it('evaluates remote delivery only when a remote sink is configured', async() => {
		await createProductionTransferring(
			{now: () => 1_000},
			{write: vi.fn(async() => {})}
		)

		expect(loads.remote).toBe(1)
	})

	it('evaluates only the selected remote provider', async() => {
		expect(loads.http).toBe(0)
		expect(loads.loki).toBe(0)

		await createLoggingSink({provider: 'http', url: 'https://logs.example.test'})
		expect(loads.http).toBe(1)
		expect(loads.loki).toBe(0)

		await createLoggingSink({provider: 'loki', url: 'https://loki.example.test'})
		expect(loads.http).toBe(1)
		expect(loads.loki).toBe(1)
	})
})
