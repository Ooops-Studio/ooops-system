import {describe, expect, it, vi} from 'vitest'

import {applyPrometheusRollingWindow} from '../../../src/features/exporters/prometheus-rolling-window'

describe('applyPrometheusRollingWindow', () => {
	it('stops safely for a missing oldest sample and removes full metric families', () => {
		const samples = new Map<string, {name: string; type: 'counter'; value: number; labels: Record<string, string>; timestamp: number}>([
			['stale', {name: 'metric', type: 'counter', value: 1, labels: {}, timestamp: 1}]
		])
		const rebuildIndexes = vi.fn()
		applyPrometheusRollingWindow({
			samples, maxBytes: 1, maxLines: 1, render: () => 'oversized\ntext',
			familyKey: () => 'family', sampleBytes: () => 1, rebuildIndexes
		})
		expect(samples.size).toBe(0)
		expect(rebuildIndexes).toHaveBeenCalled()

		const missing = new Map(samples)
		missing.set('missing', undefined as never)
		applyPrometheusRollingWindow({
			samples: missing, maxBytes: 1, maxLines: 1, render: () => 'oversized\ntext',
			familyKey: () => 'family', sampleBytes: () => 1, rebuildIndexes
		})
		expect(missing.size).toBe(0)
	})

	it('finds the exact family cutoff with logarithmically many renders', () => {
		const samples = new Map(Array.from({length: 1_024}, (_, index) => [
			`sample_${index}`,
			{name: `metric_${index}`, type: 'counter' as const, value: 1, labels: {}, timestamp: 1}
		]))
		const render = vi.fn((records: ReadonlyArray<{name: string}>) => 'x'.repeat(records.length))
		const rebuildIndexes = vi.fn()

		applyPrometheusRollingWindow({
			samples,
			maxBytes: 512,
			maxLines: 2,
			render,
			familyKey: (record) => record.name,
			sampleBytes: () => 1,
			rebuildIndexes
		})

		expect(samples.size).toBe(512)
		expect(samples.has('sample_511')).toBe(false)
		expect(samples.has('sample_512')).toBe(true)
		expect(render.mock.calls.length).toBeLessThanOrEqual(12)
		expect(rebuildIndexes).toHaveBeenCalledOnce()
	})
})
