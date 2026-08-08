import {describe, expect, it} from 'vitest'

import {inferSeverity} from '../../src/utils/guards'

describe('inferSeverity', () => {
	it('recognizes warning-level operational codes', () => {
		expect(inferSeverity({code: 'AUTH_ERROR'})).toBe('warn')
		expect(inferSeverity({code: 'UNAUTHORIZED'})).toBe('warn')
		expect(inferSeverity({code: 'FORBIDDEN'})).toBe('warn')
		expect(inferSeverity({code: 'RATE_LIMIT'})).toBe('warn')
		expect(inferSeverity({code: 'TOO_MANY_REQUESTS'})).toBe('warn')
		expect(inferSeverity({code: 'TIMEOUT'})).toBe('warn')
		expect(inferSeverity({code: 'ETIMEDOUT'})).toBe('warn')
	})

	it('recognizes explicit validation and network error kinds', () => {
		expect(inferSeverity({kind: 'ValidationError'})).toBe('info')
		expect(inferSeverity({kind: 'NetworkError'})).toBe('warn')
		expect(inferSeverity({kind: 'FetchError'})).toBe('warn')
	})

	it('does not downgrade native programming errors', () => {
		expect(inferSeverity({kind: 'TypeError'})).toBe('error')
		expect(inferSeverity({kind: 'ReferenceError'})).toBe('error')
		expect(inferSeverity({kind: 'ValidationlessError'})).toBe('error')
		expect(inferSeverity({kind: 'FetchableError'})).toBe('error')
		expect(inferSeverity({code: 'AUTHORING_FAILED'})).toBe('error')
		expect(inferSeverity({code: 'PRORATE_LIMIT_CALCULATION'})).toBe('error')
		expect(inferSeverity({code: 'SOMETIMEOUT_OCCURRED'})).toBe('error')
	})

	it('returns error for unknown inputs', () => {
		expect(inferSeverity({kind: 'Error'})).toBe('error')
		expect(inferSeverity({code: 'UNKNOWN'})).toBe('error')
		expect(inferSeverity({})).toBe('error')
	})
})
