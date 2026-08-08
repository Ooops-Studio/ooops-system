/**
 * @file Tests for classify factory.
 */

import {describe, expect, it} from 'vitest'

import {CLASSIFICATION_RULES, DEFAULT_ERROR_CATEGORIES} from '../../src/constants'
import {createClassify} from '../../src/core/classify'
import type {ErrorClassificationRegistry} from '../../src/types/error-handler'
import type {EnrichedError} from '../../src/types/normalized-error'

describe('createClassify', () => {
	it('creates classification function', () => {
		const classify = createClassify()

		expect(classify).toBeDefined()
		expect(typeof classify).toBe('function')
	})

	it('classifies errors using default registry', () => {
		const classify = createClassify()

		const error: EnrichedError = {
			kind: 'ValidationError',
			message: 'Validation error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classify(error)

		expect(result.category).not.toBe('UNKNOWN')
		expect(result.category).toBeDefined()
	})

	it('uses custom registry when provided', () => {
		const customRegistry: ErrorClassificationRegistry = {
			NETWORK: ['CustomNetworkError']
		}

		const classify = createClassify(customRegistry)

		const error: EnrichedError = {
			kind: 'CustomNetworkError',
			message: 'Network error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classify(error)

		expect(result.category).toBe('NETWORK')
	})

	it('snapshots caller-owned registries at construction', () => {
		const baseError: EnrichedError = {
			kind: 'Error', message: 'failure', severity: 'error', category: 'UNKNOWN', timestamp: 1
		}
		const patterns = ['StableError']
		const registry = {NETWORK: patterns}
		const classify = createClassify(registry)
		patterns[0] = 'MutatedError'
		patterns.push('LateError')
		registry.NETWORK = ['ReplacedError']

		expect(classify({...baseError, kind: 'StableError'}).category).toBe('NETWORK')
		expect(classify({...baseError, kind: 'MutatedError'}).category).toBe('UNKNOWN')
		expect(classify({...baseError, kind: 'LateError'}).category).toBe('UNKNOWN')
	})

	it('ignores empty custom patterns instead of matching every error code', () => {
		const classify = createClassify({NETWORK: ['', 'CustomNetworkError']})
		const baseError: EnrichedError = {
			kind: 'OtherError', code: 'UNRELATED_CODE', message: 'failure',
			severity: 'error', category: 'UNKNOWN', timestamp: 1
		}

		expect(classify(baseError).category).toBe('UNKNOWN')
		expect(classify({...baseError, kind: 'CustomNetworkError'}).category).toBe('NETWORK')
	})

	it('does not retain mutable default registry or severity rule references', () => {
		const classify = createClassify()
		const networkPatterns = DEFAULT_ERROR_CATEGORIES.NETWORK as string[]
		const rateRule = CLASSIFICATION_RULES.find((rule) => rule.category === 'RATE_LIMIT')!
		const originalPattern = networkPatterns[0]!
		const overrides = rateRule.severityOverride as Record<string, string>
		const originalOverride = overrides.error
		try {
			networkPatterns[0] = 'MutatedNetworkError'
			overrides.error = 'fatal'
			const base: EnrichedError = {
				kind: originalPattern, message: 'failure', severity: 'error',
				category: 'UNKNOWN', timestamp: 1
			}
			expect(classify(base).category).toBe('NETWORK')
			expect(classify({...base, kind: 'RateLimitError'}).severity).toBe('warn')
		} finally {
			networkPatterns[0] = originalPattern
			if (originalOverride) overrides.error = originalOverride
		}
	})

	it('adjusts severity based on category', () => {
		const classify = createClassify()

		const error: EnrichedError = {
			kind: 'ValidationError',
			message: 'Validation error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classify(error)

		expect(result.severity).toBeDefined()
		// VALIDATION errors should be downgraded to info
		if (result.category === 'VALIDATION') {
			expect(result.severity).toBe('info')
		}
	})
})
