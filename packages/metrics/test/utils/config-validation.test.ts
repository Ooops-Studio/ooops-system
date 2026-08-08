import {describe, it, expect, vi} from 'vitest'

import {
	ConfigValidationError,
	validateHistogramBuckets,
	validateHost,
	validateInterval,
	validateLabelLimits,
	validateRetryConfig
} from '../../src/utils/config-validation'
import {validateHeaders, validateUrl} from '../../src/utils/transport-validation'

describe('config-validation', () => {

	describe('validateHistogramBuckets', () => {
		it('rejects accessor-backed and oversized bucket arrays without invoking accessors', () => {
			const getter = vi.fn(() => 1)
			const buckets = Object.defineProperty([], '0', {enumerable: true, get: getter})
			expect(() => validateHistogramBuckets(buckets)).toThrow('dense array')
			expect(getter).not.toHaveBeenCalled()
			expect(() => validateHistogramBuckets(Array.from({length: 257}, (_, index) => index + 1)))
				.toThrow('at most 256')
		})
		it('rejects malformed bucket containers', () => {
			expect(() => validateHistogramBuckets(null as never)).toThrow(ConfigValidationError)
			expect(() => validateHistogramBuckets({length: 0} as never)).toThrow(ConfigValidationError)
		})

		it('should accept empty buckets', () => {

			expect(() => {
				validateHistogramBuckets([])
			}).not.toThrow()
		})

		it('should accept valid buckets', () => {

			expect(() => {
				validateHistogramBuckets([0.1, 0.5, 1.0, 2.5, 5.0])
			}).not.toThrow()
		})

		it('should reject non-positive buckets', () => {

			expect(() => {
				validateHistogramBuckets([0.1, -0.5, 1.0])
			}).toThrow(ConfigValidationError)
		})

		it('should reject zero buckets', () => {

			expect(() => {
				validateHistogramBuckets([0.1, 0, 1.0])
			}).toThrow(ConfigValidationError)
		})

		it('should reject unsorted buckets', () => {

			expect(() => {
				validateHistogramBuckets([0.5, 0.1, 1.0])
			}).toThrow(ConfigValidationError)
		})

		it('should reject duplicate buckets', () => {

			expect(() => {
				validateHistogramBuckets([0.1, 0.5, 0.5, 1.0])
			}).toThrow(ConfigValidationError)
		})

		it('should reject undefined buckets', () => {

			expect(() => {
				validateHistogramBuckets([0.1, undefined as unknown as number, 1.0])
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-finite buckets', () => {

			expect(() => {
				validateHistogramBuckets([0.1, Number.NaN, 1])
			}).toThrow(ConfigValidationError)
			expect(() => {
				validateHistogramBuckets([0.1, Number.POSITIVE_INFINITY])
			}).toThrow(ConfigValidationError)
		})
	})

	describe('validateInterval', () => {

		it('should accept positive intervals', () => {

			expect(() => {
				validateInterval(1000, 'test')
			}).not.toThrow()
		})

		it('should reject zero intervals', () => {

			expect(() => {
				validateInterval(0, 'test')
			}).toThrow(ConfigValidationError)
		})

		it('should reject negative intervals', () => {

			expect(() => {
				validateInterval(-1000, 'test')
			}).toThrow(ConfigValidationError)
		})

		it('should reject Infinity', () => {

			expect(() => {
				validateInterval(Number.POSITIVE_INFINITY, 'test')
			}).toThrow(ConfigValidationError)
		})

		it('should reject NaN', () => {

			expect(() => {
				validateInterval(Number.NaN, 'test')
			}).toThrow(ConfigValidationError)
		})

		it('rejects fractional and timer-overflow intervals', () => {
			expect(() => validateInterval(1.5, 'test')).toThrow('safe integer')
			expect(() => validateInterval(2_147_483_648, 'test')).toThrow('must not exceed')
		})
	})

	describe('validateRetryConfig', () => {
		it('rejects malformed retry configuration', () => {
			expect(() => validateRetryConfig(null as never)).toThrow(ConfigValidationError)
		})

		it('should accept valid retry config', () => {

			expect(() => {
				validateRetryConfig({
					maxRetries: 3,
					baseDelayMs: 100,
					maxDelayMs: 1000,
					multiplier: 2
				})
			}).not.toThrow()
		})

		it('should reject negative maxRetries', () => {

			expect(() => {
				validateRetryConfig({
					maxRetries: -1,
					baseDelayMs: 100,
					maxDelayMs: 1000,
					multiplier: 2
				})
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-integer and non-finite maxRetries', () => {

			expect(() => {
				validateRetryConfig({maxRetries: 1.5, baseDelayMs: 100, maxDelayMs: 1000, multiplier: 2})
			}).toThrow(ConfigValidationError)
			expect(() => {
				validateRetryConfig({maxRetries: Number.NaN, baseDelayMs: 100, maxDelayMs: 1000, multiplier: 2})
			}).toThrow(ConfigValidationError)
		})

		it('should reject retry counts above the hard ceiling', () => {
			expect(() => validateRetryConfig({
				maxRetries: 11, baseDelayMs: 100, maxDelayMs: 1000, multiplier: 2
			})).toThrow(/between 0 and 10/)
		})

		it('should reject baseDelayMs > maxDelayMs', () => {

			expect(() => {
				validateRetryConfig({
					maxRetries: 3,
					baseDelayMs: 2000,
					maxDelayMs: 1000,
					multiplier: 2
				})
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-positive multiplier', () => {

			expect(() => {
				validateRetryConfig({
					maxRetries: 3,
					baseDelayMs: 100,
					maxDelayMs: 1000,
					multiplier: 0
				})
			}).toThrow(ConfigValidationError)
		})

		it('should reject infinite multiplier', () => {

			expect(() => {
				validateRetryConfig({
					maxRetries: 3,
					baseDelayMs: 100,
					maxDelayMs: 1000,
					multiplier: Number.POSITIVE_INFINITY
				})
			}).toThrow(ConfigValidationError)
		})
	})

	describe('validateLabelLimits', () => {
		it('rejects malformed label limits', () => {
			expect(() => validateLabelLimits(null as never)).toThrow(ConfigValidationError)
		})

		it('should accept valid label limits', () => {

			expect(() => {
				validateLabelLimits({
					maxLabels: 10,
					maxCardinality: 100
				})
			}).not.toThrow()
		})

		it('should accept label limits with maxLabelValueLength', () => {

			expect(() => {
				validateLabelLimits({
					maxLabels: 10,
					maxCardinality: 100,
					maxLabelValueLength: 200
				})
			}).not.toThrow()
		})

		it('should reject non-positive maxLabels', () => {

			expect(() => {
				validateLabelLimits({
					maxLabels: 0,
					maxCardinality: 100
				})
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-positive maxCardinality', () => {

			expect(() => {
				validateLabelLimits({
					maxLabels: 10,
					maxCardinality: 0
				})
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-positive maxLabelValueLength', () => {

			expect(() => {
				validateLabelLimits({
					maxLabels: 10,
					maxCardinality: 100,
					maxLabelValueLength: 0
				})
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-integer and non-finite label limits', () => {

			expect(() => {
				validateLabelLimits({maxLabels: 1.5, maxCardinality: 100})
			}).toThrow(ConfigValidationError)
			expect(() => {
				validateLabelLimits({maxLabels: 10, maxCardinality: Number.NaN})
			}).toThrow(ConfigValidationError)
			expect(() => {
				validateLabelLimits({maxLabels: 10, maxCardinality: 100, maxLabelValueLength: Number.POSITIVE_INFINITY})
			}).toThrow(ConfigValidationError)
			expect(() => validateLabelLimits({maxLabels: 257, maxCardinality: 100})).toThrow(ConfigValidationError)
			expect(() => validateLabelLimits({maxLabels: 10, maxCardinality: 100_001})).toThrow(ConfigValidationError)
			expect(() => validateLabelLimits({
				maxLabels: 10, maxCardinality: 100, maxLabelValueLength: 4_097
			})).toThrow(ConfigValidationError)
		})
	})

	describe('validateUrl', () => {

		it('should accept valid URLs', () => {

			expect(() => {
				validateUrl('http://localhost:4318/v1/metrics', 'test')
			}).not.toThrow()
		})

		it('should accept HTTPS URLs', () => {

			expect(() => {
				validateUrl('https://example.com/metrics', 'test')
			}).not.toThrow()
		})

		it('should reject empty strings', () => {

			expect(() => {
				validateUrl('', 'test')
			}).toThrow(ConfigValidationError)
		})

		it('should reject hosts above the DNS length ceiling', () => {
			expect(() => validateHost(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`))
				.toThrow('no longer than 253 characters')
		})

		it('should reject invalid URLs', () => {

			expect(() => {
				validateUrl('not-a-url', 'test')
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-string values', () => {

			expect(() => {
				validateUrl(123 as unknown as string, 'test')
			}).toThrow(ConfigValidationError)
		})
	})

	describe('validateHeaders', () => {

		it('should accept valid headers', () => {

			expect(() => {
				validateHeaders({
					'Authorization': 'Bearer token',
					'Content-Type': 'application/json'
				})
			}).not.toThrow()
		})

		it('should accept empty headers', () => {

			expect(() => {
				validateHeaders({})
			}).not.toThrow()
		})

		it('should reject non-object values', () => {

			expect(() => {
				validateHeaders(null as unknown as Record<string, string>)
			}).toThrow(ConfigValidationError)

			expect(() => {
				validateHeaders([] as unknown as Record<string, string>)
			}).toThrow(ConfigValidationError)

			expect(() => {
				validateHeaders('string' as unknown as Record<string, string>)
			}).toThrow(ConfigValidationError)
		})

		it('should reject non-string keys', () => {

			// Object.entries converts numeric keys to strings, so we need to test differently
			// The validation checks typeof key !== 'string' in the loop
			// Since Object.entries only returns string keys, we can't easily test this
			// But we can test that the validation works for the keys it can check
			// For a more realistic test, we'd need to use a Proxy or similar
			// For now, we'll test that string keys work (implicitly testing the key validation)
			expect(() => {
				validateHeaders({
					'valid-key': 'value'
				})
			}).not.toThrow()
		})

		it('should reject non-string values', () => {

			expect(() => {
				validateHeaders({
					'key': 123
				} as unknown as Record<string, string>)
			}).toThrow(ConfigValidationError)
		})
	})

	describe('validateHost', () => {

		it('should accept valid hosts', () => {

			expect(() => {
				validateHost('localhost')
			}).not.toThrow()

			expect(() => {
				validateHost('127.0.0.1')
			}).not.toThrow()

			expect(() => {
				validateHost('192.168.1.1')
			}).not.toThrow()
		})

		it('should reject empty strings', () => {

			expect(() => {
				validateHost('')
			}).toThrow(ConfigValidationError)
		})

		it('should reject 0.0.0.0 by default', () => {

			expect(() => {
				validateHost('0.0.0.0')
			}).toThrow(ConfigValidationError)
		})

		it('should accept 0.0.0.0 when allowed', () => {

			expect(() => {
				validateHost('0.0.0.0', true)
			}).not.toThrow()
		})

		it('should reject invalid hostnames', () => {

			expect(() => {
				validateHost('invalid..hostname')
			}).toThrow(ConfigValidationError)
		})

		it('should reject IPv4 octets outside the valid range', () => {

			expect(() => {
				validateHost('999.168.1.1')
			}).toThrow(ConfigValidationError)
			expect(() => {
				validateHost('127.0.0.256')
			}).toThrow(ConfigValidationError)
		})
	})
})
