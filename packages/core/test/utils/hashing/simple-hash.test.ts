import {describe, it, expect, vi} from 'vitest'

import {simpleHash} from '../../../src/utils/hashing/simple-hash'

describe('simpleHash', () => {
	it('should return a string', () => {
		const hash = simpleHash('test')
		expect(typeof hash).toBe('string')
	})

	it('should return base36-encoded hash', () => {
		const hash = simpleHash('test')
		expect(hash).toMatch(/^[0-9a-z]+$/)
	})

	it('should produce consistent hashes for same input', () => {
		const hash1 = simpleHash('test')
		const hash2 = simpleHash('test')
		expect(hash1).toBe(hash2)
	})

	it('should produce different hashes for different inputs', () => {
		const hash1 = simpleHash('test1')
		const hash2 = simpleHash('test2')
		expect(hash1).not.toBe(hash2)
	})

	it('should handle empty string', () => {
		const hash = simpleHash('')
		expect(typeof hash).toBe('string')
		expect(hash.length).toBeGreaterThan(0)
	})

	it('should handle long strings', () => {
		const longString = 'a'.repeat(1000)
		const hash = simpleHash(longString)
		expect(typeof hash).toBe('string')
	})

	it('should handle special characters', () => {
		const hash1 = simpleHash('hello world')
		const hash2 = simpleHash('hello-world')
		expect(hash1).not.toBe(hash2)
	})

	it('should handle unicode characters', () => {
		const hash1 = simpleHash('hello')
		const hash2 = simpleHash('héllo')
		expect(hash1).not.toBe(hash2)
	})

	it('should produce different hashes for case differences', () => {
		const hash1 = simpleHash('Test')
		const hash2 = simpleHash('test')
		expect(hash1).not.toBe(hash2)
	})

	it('bounds runtime input without invoking coercion hooks', () => {
		const coercion = vi.fn(() => 'safe')
		expect(() => simpleHash({length: Infinity, charCodeAt: vi.fn(), toString: coercion} as never))
			.toThrow('must be a string')
		expect(coercion).not.toHaveBeenCalled()
		expect(() => simpleHash('x'.repeat(1_000_001))).toThrow('at most 1000000')
	})
})
