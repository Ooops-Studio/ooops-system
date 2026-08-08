/**
 * @file Tests for metrics reporter.
 */

import {describe, expect, it, vi, beforeEach} from 'vitest'

import {reportToMetrics} from '../../../src/features/reporters/metrics-reporter'
import type {EnrichedError} from '../../../src/types/normalized-error'
import type {MetricsPort} from '../../../src/types/ports'

describe('reportToMetrics', () => {

	let mockMetrics: MetricsPort

	beforeEach(() => {
		mockMetrics = {
			increment: vi.fn()
		}
	})

	it('does nothing when metrics port is not provided', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToMetrics(error)

		expect(mockMetrics.increment).not.toHaveBeenCalled()
	})

	it('does not report metrics-service failures back through the failing metrics port', async() => {
		await reportToMetrics({
			kind: 'Error', message: 'export failed', severity: 'error',
			category: 'UNKNOWN', source: 'metrics', timestamp: 1
		}, mockMetrics)

		expect(mockMetrics.increment).not.toHaveBeenCalled()
	})

	it('increments errors_total metric', async() => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await reportToMetrics(error, mockMetrics)

		expect(mockMetrics.increment).toHaveBeenCalledWith('errors_total', {
			severity: 'error',
			category: 'UNKNOWN'
		})
	})

	it('propagates metrics errors so reportAll can record delivery failure', async() => {
		mockMetrics.increment = vi.fn().mockImplementation(() => {
			throw new Error('Metrics error')
		})

		const error: EnrichedError = {
			kind: 'Error',
			message: 'Test error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		await expect(reportToMetrics(error, mockMetrics)).rejects.toThrow('Metrics error')
	})
})
