import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

import {byteSize} from '../../src/utils/byte-size'

describe('byteSize', () => {
	it('preserves UTF-8 sizing after String.prototype.charCodeAt is rewired', () => {
		const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(() => {
			throw new Error('rewired charCodeAt')
		})
		let result: number | undefined
		try { result = byteSize('hello 🌍') } finally { charCodeAt.mockRestore() }
		expect(result).toBe(10)
	})

	const originalTextEncoder = globalThis.TextEncoder
	const originalBuffer = globalThis.Buffer

	beforeEach(() => {

		vi.clearAllMocks()
	})

	afterEach(() => {

		// Restore originals
		if (globalThis.TextEncoder !== originalTextEncoder) {
			Object.defineProperty(globalThis, 'TextEncoder', {
				value: originalTextEncoder,
				writable: true,
				configurable: true
			})
		}
		if (globalThis.Buffer !== originalBuffer) {
			Object.defineProperty(globalThis, 'Buffer', {
				value: originalBuffer,
				writable: true,
				configurable: true
			})
		}
	})

	it('should calculate byte size for ASCII strings', () => {

		expect(byteSize('hello')).toBe(5)
		expect(byteSize('test')).toBe(4)
		expect(byteSize('')).toBe(0)
	})

	it('should calculate byte size for 2-byte UTF-8 characters', () => {

		expect(byteSize('ñ')).toBe(2)
		expect(byteSize('é')).toBe(2)
		expect(byteSize('ñé')).toBe(4)
	})

	it('should calculate byte size for 3-byte UTF-8 characters', () => {

		expect(byteSize('中')).toBe(3)
		expect(byteSize('文')).toBe(3)
		expect(byteSize('中文')).toBe(6)
	})

	it('should calculate byte size for 4-byte UTF-8 characters (surrogate pairs)', () => {

		expect(byteSize('😀')).toBe(4)
		expect(byteSize('🚀')).toBe(4)
		expect(byteSize('😀🚀')).toBe(8)
	})

	it('should handle mixed character types', () => {

		expect(byteSize('hello 世界 😀')).toBe(17) // 5 (hello) + 1 (space) + 6 (世界) + 1 (space) + 4 (😀)
		// 4 (test) + 1 (space) + 2 (ñ) + 1 (space) + 2 (é) + 1 (space) + 3 (中) = 14
		expect(byteSize('test ñ é 中')).toBe(14)
	})

	it('should handle invalid surrogate pairs', () => {

		// High surrogate without low surrogate
		const highSurrogate = String.fromCharCode(0xD800)
		expect(byteSize(highSurrogate)).toBe(3) // Treated as 3-byte sequence
	})

	it('should handle high surrogate at end of string', () => {

		const highSurrogate = String.fromCharCode(0xD800)
		const str = 'test' + highSurrogate
		const size = byteSize(str)

		// Should handle high surrogate without low surrogate
		expect(size).toBeGreaterThan(4)
	})

	it('should handle low surrogate without high surrogate', () => {

		const lowSurrogate = String.fromCharCode(0xDC00)
		const size = byteSize(lowSurrogate)

		// Should treat as 3-byte sequence
		expect(size).toBe(3)
	})

	it('should handle valid surrogate pairs', () => {

		// Valid surrogate pair: high (0xD800-0xDBFF) + low (0xDC00-0xDFFF)
		const high = String.fromCharCode(0xD800)
		const low = String.fromCharCode(0xDC00)
		const pair = high + low

		expect(byteSize(pair)).toBe(4)
	})

	it('should handle strings with special characters', () => {

		expect(byteSize('Hello, 世界! 🌍')).toBe(19)
		// Café résumé: C(1) + a(1) + f(1) + é(2) + space(1) + r(1) +
		// é(2) + s(1) + u(1) + m(1) + é(2) = 14
		expect(byteSize('Café résumé')).toBe(14)
	})

	it('should handle very long strings', () => {

		const longString = 'a'.repeat(1000)
		expect(byteSize(longString)).toBe(1000)
	})

	it('should handle strings with newlines and tabs', () => {

		expect(byteSize('hello\nworld')).toBe(11)
		expect(byteSize('hello\tworld')).toBe(11)
		expect(byteSize('hello\r\nworld')).toBe(12)
	})

	it('measures directly without allocating through host encoders', () => {
		const encode = vi.spyOn(TextEncoder.prototype, 'encode')
		const bufferByteLength = vi.spyOn(Buffer, 'byteLength')
		try {
			expect(byteSize('hello 😀 中')).toBe(14)
			expect(encode).not.toHaveBeenCalled()
			expect(bufferByteLength).not.toHaveBeenCalled()
		} finally {
			encode.mockRestore()
			bufferByteLength.mockRestore()
		}
	})

	it('rejects non-string runtime values without invoking coercion hooks', () => {
		const coercion = vi.fn(() => 'secret')
		expect(() => byteSize({toString: coercion} as never)).toThrow(TypeError)
		expect(coercion).not.toHaveBeenCalled()
	})

	it('should handle edge case characters correctly', () => {

		// Test boundary values
		expect(byteSize(String.fromCharCode(0x7F))).toBe(1) // Last ASCII
		expect(byteSize(String.fromCharCode(0x80))).toBe(2) // First 2-byte
		expect(byteSize(String.fromCharCode(0x7FF))).toBe(2) // Last 2-byte
		expect(byteSize(String.fromCharCode(0x800))).toBe(3) // First 3-byte
		expect(byteSize(String.fromCharCode(0xD7FF))).toBe(3) // Before surrogates
		expect(byteSize(String.fromCharCode(0xE000))).toBe(3) // After surrogates
		expect(byteSize(String.fromCharCode(0xFFFF))).toBe(3) // Last BMP
	})
})
