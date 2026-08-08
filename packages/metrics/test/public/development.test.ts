import {describe, expect, it, vi} from 'vitest'

import {createDevelopmentMetrics} from '../../src/public/development'

describe('development metrics', () => {
	it('provides an async app-mounted Prometheus handler without lifecycle controls', async() => {
		const metrics = await createDevelopmentMetrics({console: false})
		metrics.increment('development_requests_total')
		await metrics.flush()
		const scrape = metrics.getPrometheusScrape()
		expect(scrape.body).toContain('development_requests_total')
		expect(scrape.contentType).toContain('text/plain')
		expect('ready' in metrics).toBe(false)
		expect('destroy' in metrics).toBe(false)
		await metrics.shutdown()
	})

	it('captures public options without invoking accessors', async() => {
		const getter = vi.fn(() => false)
		const options = Object.defineProperty({}, 'console', {enumerable: true, get: getter})
		await expect(createDevelopmentMetrics(options as never)).rejects.toThrow('stable known data fields')
		expect(getter).not.toHaveBeenCalled()
	})

	it('accepts bootstrap instrument definitions', async() => {
		const metrics = await createDevelopmentMetrics({
			console: false,
			instruments: [{
				name: 'jobs_active', instrument: 'up_down_counter', labels: ['queue-name']
			}]
		})
		metrics.upDownCounter('jobs_active', 2, {'queue-name': 'default'})
		metrics.upDownCounter('jobs_active', -1, {queue_name: 'default'})
		expect(() => metrics.upDownCounter('jobs_active', 1, {unexpected: 'value'}))
			.toThrow('Label outside schema')
		await metrics.flush()
		expect(metrics.getPrometheusScrape().body).toContain('jobs_active{queue_name="default"} 1')
		await metrics.shutdown()
	})

	it('normalizes timer definitions to the durationMs API unit', async() => {
		const metrics = await createDevelopmentMetrics({
			console: false,
			instruments: [{
				name: 'request_duration', instrument: 'timer', unit: 's'
			}]
		})
		metrics.timer('request_duration', 25)
		await metrics.flush()
		const scrape = metrics.getPrometheusScrape('openmetrics').body
		expect(scrape).toContain('(unit: ms)')
		expect(scrape).not.toContain('(unit: s)')
		expect(scrape).toContain('request_duration_bucket{le="2500"}')
		expect(scrape).toContain('request_duration_bucket{le="5000"}')
		expect(scrape).toContain('request_duration_bucket{le="10000"}')
		await metrics.shutdown()
	})
})
