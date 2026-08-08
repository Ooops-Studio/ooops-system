/**
 * @file Tests for error classification.
 */

import {describe, expect, it, vi} from 'vitest'

import {
	classifyError,
	isValidClassificationRegistryConfiguration,
	snapshotClassificationRegistry
} from '../../../src/features/classification/classify-error'
import type {ErrorClassificationRegistry} from '../../../src/types/error-handler'
import type {EnrichedError} from '../../../src/types/normalized-error'

describe('classifyError', () => {
	it('strictly rejects malformed or hostile long-lived classification configuration', () => {
		const accessorRegistry = {} as ErrorClassificationRegistry
		Object.defineProperty(accessorRegistry, 'NETWORK', {
			enumerable: true,
			get: () => ['NetworkError']
		})
		const extraArrayProperty = ['NetworkError'] as string[] & {metadata?: string}
		extraArrayProperty.metadata = 'caller-owned'
		const hostileRegistry = new Proxy({}, {
			ownKeys() { throw new Error('blocked') }
		}) as ErrorClassificationRegistry

		for (const registry of [
			Object.fromEntries(Array.from({length: 65}, (_, index) => [`UNKNOWN_${index}`, []])),
			{NOT_A_CATEGORY: ['NetworkError']},
			accessorRegistry,
			{NETWORK: Array.from({length: 101}, () => 'NetworkError')},
			{NETWORK: extraArrayProperty},
			{NETWORK: ['']},
			{NETWORK: ['x'.repeat(129)]},
			hostileRegistry
		]) {
			expect(isValidClassificationRegistryConfiguration(
				registry as ErrorClassificationRegistry
			)).toBe(false)
		}
		expect(isValidClassificationRegistryConfiguration({NETWORK: ['NetworkError']})).toBe(true)
	})

	it('takes an immutable bounded descriptor-only registry snapshot', () => {
		const patterns = ['NetworkError', '', 'x'.repeat(129)]
		const snapshot = snapshotClassificationRegistry({NETWORK: patterns})
		patterns[0] = 'MutatedError'

		expect(snapshot).toEqual({NETWORK: ['NetworkError']})
		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot.NETWORK)).toBe(true)
	})

	it('does not invoke get traps on classification pattern arrays', () => {
		const get = vi.fn((_target: string[], key: PropertyKey, receiver: unknown) =>
			Reflect.get(_target, key, receiver))
		const patterns = new Proxy(['CustomError'], {get})
		const registry = {BUSINESS_LOGIC: patterns}

		expect(classifyError({
			kind: 'CustomError', message: 'failure', severity: 'error', category: 'UNKNOWN', timestamp: 1
		}, registry)).toMatchObject({
			category: 'BUSINESS_LOGIC'
		})
		expect(get).not.toHaveBeenCalled()
	})

	it('fails closed when classification pattern descriptors are unavailable', () => {
		const lengthFailure = new Proxy(['CustomError'], {
			getOwnPropertyDescriptor(_target, key) {
				if (key === 'length') throw new Error('unavailable length')
				return Reflect.getOwnPropertyDescriptor(_target, key)
			}
		})
		const entryFailure = new Proxy(['CustomError'], {
			getOwnPropertyDescriptor(_target, key) {
				if (key === '0') throw new Error('unavailable entry')
				return Reflect.getOwnPropertyDescriptor(_target, key)
			}
		})
		const error: EnrichedError = {
			kind: 'CustomError', message: 'failure', severity: 'error', category: 'UNKNOWN', timestamp: 1
		}

		expect(classifyError(error, {BUSINESS_LOGIC: lengthFailure})).toMatchObject({category: 'UNKNOWN'})
		expect(classifyError(error, {BUSINESS_LOGIC: entryFailure})).toMatchObject({category: 'UNKNOWN'})
	})

	it('classifies malformed direct inputs as safe unknown errors', () => {
		expect(classifyError(null as never)).toMatchObject({
			kind: 'UnknownError', category: 'UNKNOWN', severity: 'error'
		})
	})
	it('classifies error by kind from default registry', () => {
		const error: EnrichedError = {
			kind: 'ValidationError',
			message: 'Validation error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('VALIDATION')
	})

	it('classifies error by code when kind does not match', () => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Network error',
			severity: 'error',
			category: 'UNKNOWN',
			code: 'ECONNRESET',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('NETWORK')
	})

	it('uses custom registry when provided', () => {
		const customRegistry: ErrorClassificationRegistry = {
			NETWORK: ['CustomNetworkError']
		}

		const error: EnrichedError = {
			kind: 'CustomNetworkError',
			message: 'Network error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classifyError(error, customRegistry)

		expect(result.category).toBe('NETWORK')
	})

	it('ignores unknown runtime category keys in custom registries', () => {
		const error: EnrichedError = {
			kind: 'ExternalError',
			message: 'external failure',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classifyError(error, {
			'user@example.com': ['ExternalError']
		} as ErrorClassificationRegistry)

		expect(result.category).toBe('UNKNOWN')
	})

	it('treats hostile custom registries as no match', () => {
		const error: EnrichedError = {
			kind: 'ExternalError',
			message: 'external failure',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}
		const registry = new Proxy({}, {
			ownKeys() {
				throw new Error('registry enumeration failed')
			}
		}) as ErrorClassificationRegistry

		expect(() => classifyError(error, registry)).not.toThrow()
		expect(classifyError(error, registry).category).toBe('UNKNOWN')
	})

	it('treats hostile error descriptors as unavailable classification input', () => {
		const hostile = new Proxy({}, {
			getOwnPropertyDescriptor() { throw new Error('descriptor token=must-not-escape') }
		})
		expect(() => classifyError(hostile as EnrichedError)).not.toThrow()
		expect(classifyError(hostile as EnrichedError)).toMatchObject({
			kind: 'UnknownError', category: 'UNKNOWN', severity: 'error'
		})
	})

	it('bounds raw machine identifiers before pattern matching', () => {
		const oversized = `prefix-${'x'.repeat(2_000)}-RATE_LIMIT`
		const result = classifyError({
			kind: oversized, code: oversized, message: 'failure', severity: 'error',
			category: 'UNKNOWN', timestamp: 1
		})
		expect(result).toMatchObject({category: 'UNKNOWN', severity: 'error'})
		expect(result.kind).not.toBe(oversized)
		expect(result.code).not.toBe(oversized)
	})

	it('ignores hostile pattern arrays and registry accessors', () => {
		const error: EnrichedError = {
			kind: 'ExternalError', message: 'failure', severity: 'error', category: 'UNKNOWN', timestamp: 1
		}
		const patterns = new Proxy(['ExternalError'], {
			getOwnPropertyDescriptor() { throw new Error('pattern descriptor blocked') }
		})
		const registry = {NETWORK: patterns} as ErrorClassificationRegistry
		expect(classifyError(error, registry).category).toBe('UNKNOWN')

		const accessorRegistry = {} as ErrorClassificationRegistry
		Object.defineProperty(accessorRegistry, 'NETWORK', {
			enumerable: true, get: () => ['ExternalError']
		})
		expect(classifyError(error, accessorRegistry).category).toBe('UNKNOWN')
	})

	it('adjusts severity for VALIDATION errors', () => {
		const error: EnrichedError = {
			kind: 'ValidationError',
			message: 'Validation error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('VALIDATION')
		expect(result.severity).toBe('info')
	})

	it('adjusts severity for NETWORK errors', () => {
		const error: EnrichedError = {
			kind: 'NetworkError', // This kind is in the NETWORK category
			message: 'Network error',
			severity: 'error',
			category: 'UNKNOWN', // Will be classified to NETWORK
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('NETWORK')
		expect(result.severity).toBe('warn')
	})

	it('adjusts severity for TIMEOUT errors', () => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Timeout error',
			severity: 'error',
			category: 'UNKNOWN',
			code: 'ETIMEDOUT',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('TIMEOUT')
		expect(result.severity).toBe('warn')
	})

	it('does not downgrade native programming errors', () => {
		const result = classifyError({
			kind: 'TypeError', message: 'programming failure', severity: 'error',
			category: 'UNKNOWN', timestamp: 1
		})
		expect(result.category).toBe('UNKNOWN')
		expect(result.severity).toBe('error')
	})

	it('adjusts severity for TIMEOUT category directly', () => {
		// Test lines 51-52: TIMEOUT category with error severity
		// Use a custom registry to ensure TIMEOUT category is used
		const customRegistry: ErrorClassificationRegistry = {
			TIMEOUT: ['CustomTimeoutError']
		}

		const error: EnrichedError = {
			kind: 'CustomTimeoutError', // This kind is in TIMEOUT category in custom registry
			message: 'Timeout error',
			severity: 'error',
			category: 'UNKNOWN', // Will be classified to TIMEOUT
			timestamp: Date.now()
		}

		const result = classifyError(error, customRegistry)

		// Should adjust severity from error to warn for TIMEOUT category
		expect(result.category).toBe('TIMEOUT')
		expect(result.severity).toBe('warn')
	})

	it('adjusts severity for RATE_LIMIT errors', () => {
		const error: EnrichedError = {
			kind: 'RateLimitError', // This kind is in the RATE_LIMIT category
			message: 'Rate limit error',
			severity: 'error',
			category: 'UNKNOWN', // Will be classified to RATE_LIMIT
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('RATE_LIMIT')
		expect(result.severity).toBe('warn')
	})

	it('preserves sensitive-looking built-in identifiers until classification', () => {
		const result = classifyError({
			kind: 'AuthorizationError',
			message: 'denied',
			code: 'AUTHORIZATION_FAILED',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: 1
		})

		expect(result).toMatchObject({
			kind: 'AuthorizationError', code: 'AUTHORIZATION_FAILED', category: 'AUTHORIZATION'
		})
	})

	it('upgrades AUTHENTICATION errors to at least warn', () => {
		const error: EnrichedError = {
			kind: 'AuthenticationError', // This kind is in the AUTHENTICATION category
			message: 'Auth error',
			severity: 'info',
			category: 'UNKNOWN', // Will be classified to AUTHENTICATION
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('AUTHENTICATION')
		expect(result.severity).toBe('warn')
	})

	it('sets CONFIG errors to error severity', () => {
		const error: EnrichedError = {
			kind: 'ConfigError', // This kind is in the CONFIG category
			message: 'Config error',
			severity: 'warn',
			category: 'UNKNOWN', // Will be classified to CONFIG
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('CONFIG')
		expect(result.severity).toBe('error')
	})

	it('returns UNKNOWN category when no match found', () => {
		const error: EnrichedError = {
			kind: 'UnknownError',
			message: 'Unknown error',
			severity: 'error',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('UNKNOWN')
	})

	it('preserves explicit non-UNKNOWN categories', () => {
		const error: EnrichedError = {
			kind: 'Error',
			message: 'Forbidden',
			severity: 'info',
			category: 'AUTHORIZATION',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('AUTHORIZATION')
		expect(result.severity).toBe('warn')
	})

	it('ensures unclassified errors (no matching kind/code) land in UNKNOWN category with ERROR severity', () => {
		// Test unknown type fallback: errors with no matching kind or code
		// should be classified as UNKNOWN with ERROR severity (not info/warn)
		const error: EnrichedError = {
			kind: 'CompletelyUnknownErrorType',
			message: 'Some random error',
			severity: 'info', // Even if severity is info, unclassified should be ERROR
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('UNKNOWN')
		expect(result.severity).toBe('error') // Unclassified errors default to ERROR severity
	})

	it('ensures unclassified errors with no code also default to ERROR severity', () => {
		const error: EnrichedError = {
			kind: 'RandomError',
			message: 'Random error without code',
			severity: 'info',
			category: 'UNKNOWN',
			timestamp: Date.now()
		}

		const result = classifyError(error)

		expect(result.category).toBe('UNKNOWN')
		expect(result.severity).toBe('error') // Unclassified errors default to ERROR severity
	})

	it.each([
		['UNAUTHORIZED', 'AUTHENTICATION', 'error'],
		['FORBIDDEN', 'AUTHORIZATION', 'error'],
		['RATE_LIMITED', 'RATE_LIMIT', 'warn'],
		['TOO_MANY_REQUESTS', 'RATE_LIMIT', 'warn'],
		['REQUEST_TIMEOUT', 'TIMEOUT', 'warn']
	] as const)('classifies machine code %s consistently as %s', (code, category, severity) => {
		const result = classifyError({
			kind: 'ServiceError', message: 'operation failed', code,
			severity: 'error', category: 'UNKNOWN', timestamp: 1
		})
		expect(result.category).toBe(category)
		expect(result.severity).toBe(severity)
	})

	it.each([
		'AUTHORING_FAILED',
		'PRORATE_LIMIT_CALCULATION',
		'SOMETIMEOUT_OCCURRED'
	])('does not classify an unrelated substring in machine code %s', (code) => {
		const result = classifyError({
			kind: 'ServiceError', message: 'programming failure', code,
			severity: 'error', category: 'UNKNOWN', timestamp: 1
		})
		expect(result).toMatchObject({category: 'UNKNOWN', severity: 'error'})
	})
})
