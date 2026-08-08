import {describe, expect, it} from 'vitest'

import * as constants from '../../src/constants'

describe('metrics self-metric contract', () => {
	it('defines exactly the seven bounded self metrics', () => {
		const names = Object.entries(constants)
			.filter(([key]) => key.startsWith('METRIC_SELF_'))
			.map(([, value]) => value)
			.sort()
		expect(names).toEqual([
			'_metrics_active_series',
			'_metrics_dropped_total',
			'_metrics_export_failures_total',
			'_metrics_export_retries_total',
			'_metrics_finalization_failures_total',
			'_metrics_queue_size',
			'_metrics_recorded_total'
		])
	})
})
