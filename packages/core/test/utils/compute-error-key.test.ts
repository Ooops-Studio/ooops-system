import {describe, it, expect, vi} from 'vitest'

import type {EnrichedError} from '../../src/contracts/errors'
import {computeErrorKey} from '../../src/utils/compute-error-key'
import {simpleHash} from '../../src/utils/hashing/simple-hash'

describe('computeErrorKey', () => {
	it('should compute key from message and category', () => {
		const error: EnrichedError = {
			message: 'Test error',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key = computeErrorKey(error)

		expect(key).toMatch(/^error:validation:/)
		expect(key).toContain(':')
	})

	it('should include code hash when code is provided', () => {
		const error: EnrichedError = {
			message: 'Test error',
			category: 'validation',
			code: 'ERR_TEST',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key = computeErrorKey(error)

		expect(key).toMatch(/^error:validation:/)
		expect(key.split(':')).toHaveLength(4) // error:category:messageHash:codeHash
	})

	it('should handle errors without code', () => {
		const error: EnrichedError = {
			message: 'Test error',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key = computeErrorKey(error)

		expect(key).toMatch(/^error:validation:/)
		expect(key.split(':')).toHaveLength(4) // codeHash is empty string
		expect(key.endsWith(':')).toBe(true)
	})

	it('should produce consistent keys for same error', () => {
		const error: EnrichedError = {
			message: 'Test error',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key1 = computeErrorKey(error)
		const key2 = computeErrorKey(error)

		expect(key1).toBe(key2)
	})

	it('should produce different keys for different messages', () => {
		const error1: EnrichedError = {
			message: 'Error 1',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const error2: EnrichedError = {
			message: 'Error 2',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key1 = computeErrorKey(error1)
		const key2 = computeErrorKey(error2)

		expect(key1).not.toBe(key2)
	})

	it('should produce different keys for different error kinds', () => {
		const first = {
			kind: 'TypeError', message: 'same error', category: 'UNKNOWN',
			severity: 'error', timestamp: 1
		} as const satisfies EnrichedError
		const second = {...first, kind: 'ReferenceError'} as const satisfies EnrichedError

		expect(computeErrorKey(first)).not.toBe(computeErrorKey(second))
	})

	it('does not merge distinct messages with a known 32-bit polynomial collision', () => {
		const first: EnrichedError = {
			message: 'Aa', category: 'validation', severity: 'error', timestamp: 1
		}
		const second: EnrichedError = {
			message: 'BB', category: 'validation', severity: 'error', timestamp: 1
		}

		expect(computeErrorKey(first)).not.toBe(computeErrorKey(second))
	})

	it('should produce different keys for different categories', () => {
		const error1: EnrichedError = {
			message: 'Test error',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const error2: EnrichedError = {
			message: 'Test error',
			category: 'network',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key1 = computeErrorKey(error1)
		const key2 = computeErrorKey(error2)

		expect(key1).not.toBe(key2)
	})

	it('bounds categories after RegExp.prototype.test is rewired', () => {
		const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')!
		let key = ''
		try {
			Object.defineProperty(RegExp.prototype, 'test', {
				configurable: true,
				writable: true,
				value: () => true
			})
			key = computeErrorKey({
				message: 'failure', category: `unsafe:${'x'.repeat(100_000)}`,
				severity: 'error', timestamp: 1
			})
		} finally {
			Object.defineProperty(RegExp.prototype, 'test', descriptor)
		}

		expect(key).toMatch(/^error:UNKNOWN:/u)
		expect(key.length).toBeLessThan(256)
	})

	it('preserves error-key hashing after string and numeric intrinsics are rewired', () => {
		const error: EnrichedError = {
			message: 'failure', category: 'network', severity: 'error', timestamp: 1,
			code: 'ECONNRESET'
		}
		const expected = computeErrorKey(error)
		const targets = [
			[String.prototype, 'charCodeAt'], [String.prototype, 'slice'],
			[Number.prototype, 'toString'], [Math, 'abs'], [Math, 'floor'],
			[Object, 'getOwnPropertyDescriptor']
		] as const
		const descriptors = targets.map((entry) => Object.getOwnPropertyDescriptor(entry[0], entry[1])!)
		const poison = (): never => { throw new Error('rewired hashing intrinsic') }
		let actual: string | undefined
		let failure: unknown
		try {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				Object.defineProperty(entry[0], entry[1], {
					configurable: true, writable: true, value: poison
				})
			}
			try { actual = computeErrorKey(error) } catch(error) { failure = error }
		} finally {
			for (let index = 0; index < targets.length; index += 1) {
				const entry = targets[index]!
				Object.defineProperty(entry[0], entry[1], descriptors[index]!)
			}
		}

		expect(failure).toBeUndefined()
		expect(actual).toBe(expected)
	})

	it('should handle policy mode option', () => {
		const error: EnrichedError = {
			message: 'Test error',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key1 = computeErrorKey(error, {policyMode: false})
		const key2 = computeErrorKey(error, {policyMode: true})

		// Currently policy mode uses same logic, but structure allows future differentiation
		expect(key1).toBe(key2)
	})

	it('should handle empty message', () => {
		const error: EnrichedError = {
			message: '',
			category: 'validation',
			severity: 'error',
			timestamp: 1234567890000
		}

		const key = computeErrorKey(error)

		expect(key).toMatch(/^error:validation:/)
	})

	it('preserves the legacy code-point reverse digest for unicode input', () => {
		const error = {
			kind: '🤖Type', message: 'before 🚀 after', category: 'unicode',
			severity: 'error', timestamp: 1
		} as const satisfies EnrichedError
		const combined = `${error.kind}\0${error.message}`
		const legacyReverse = Array.from(combined).reverse().join('')

		expect(computeErrorKey(error)).toBe(
			`error:unicode:${simpleHash(combined)}.${simpleHash(legacyReverse)}.${combined.length.toString(36)}:`
		)
	})

	it('computes a key for a large message without a reverse-copy helper', () => {
		const error = {
			message: 'x'.repeat(2_000_000), category: 'large', severity: 'error', timestamp: 1
		} as const satisfies EnrichedError

		expect(computeErrorKey(error)).toMatch(/^error:large:/)
	})

	it('does not execute accessors and sanitizes key delimiters', () => {
		let reads = 0
		const error = Object.defineProperties({}, {
			message: {enumerable: true, get: () => { reads++; return 'secret' }},
			category: {value: 'unsafe:\ncategory', enumerable: true},
			severity: {value: 'error', enumerable: true},
			timestamp: {value: 1, enumerable: true}
		}) as EnrichedError

		expect(computeErrorKey(error)).toMatch(/^error:UNKNOWN:/)
		expect(computeErrorKey(error)).not.toContain('unsafe')
		expect(reads).toBe(0)
	})

	it('does not inspect proxied errors', () => {
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const error = new Proxy({message: 'secret', category: 'unsafe'}, {getOwnPropertyDescriptor})

		expect(computeErrorKey(error as EnrichedError)).toMatch(/^error:UNKNOWN:/)
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})
})
