import {describe, expect, it, vi} from 'vitest'

import {maskSpanAttributes} from '../../../src/core/span-redaction'
import {createSpanRedaction, maskAttributes} from '../../../src/features/redaction/span-redaction'

describe('createSpanRedaction', () => {
	it('keeps mandatory protection and recursively applies additive key rules', () => {
		const redact = createSpanRedaction({rules: [
			{key: 'tenant-id', action: 'mask'},
			{key: 'discard', action: 'drop'},
			{key: 'summary', action: 'truncate', maxBytes: 4}
		]})
		expect(redact({
			authorization: 'Bearer secret',
			tenant_id: 'acme',
			nested: {discard: 'hidden', summary: 'abcdefgh', token: 'secret'}
		})).toEqual({
			authorization: '***',
			tenant_id: '***',
			nested: {summary: '[Tru', token: '***'}
		})
	})

	it('truncates in linear work and keeps the complete result inside maxBytes', () => {
		const encode = vi.spyOn(TextEncoder.prototype, 'encode')
		const redact = createSpanRedaction({rules: [
			{key: 'summary', action: 'truncate', maxBytes: 8_191}
		]})
		const result = redact({summary: 'x'.repeat(8_192)}).summary
		expect(encode).toHaveBeenCalledTimes(2)
		encode.mockRestore()
		expect(typeof result).toBe('string')
		expect(new TextEncoder().encode(result as string).byteLength).toBeLessThanOrEqual(8_191)
		expect(result).toMatch(/\[Truncated\]$/u)
	})

	it('clones regular expressions and never leaks mutable lastIndex', () => {
		const key = /^private-/gu
		const redact = createSpanRedaction({rules: [{key, action: 'mask'}]})
		key.lastIndex = 50
		expect(redact({'private-one': 'a', 'private-two': 'b'})).toEqual({
			'private-one': '***', 'private-two': '***'
		})
	})

	it('keeps queryless observability URLs while redacting URLs with sensitive components', () => {
		const redact = createSpanRedaction()
		expect(redact({
			endpoint: 'https://example.com/provider',
			unsafe: 'https://example.com/provider?token=secret'
		})).toEqual({
			endpoint: 'https://example.com/provider',
			unsafe: '[REDACTED]'
		})
	})

	it('validates the hard-break rule shape and bounded truncate bytes', () => {
		expect(() => createSpanRedaction({rules: [{key: 'x', action: 'truncate', maxBytes: 0}]})).toThrow('maxBytes')
		expect(() => createSpanRedaction({rules: [{key: 'x', action: 'truncate', maxBytes: 8_193}]})).toThrow('maxBytes')
		expect(() => createSpanRedaction({rules: [{key: 'x', action: 'mask', maxBytes: 1} as never]})).toThrow('only valid')
		expect(() => createSpanRedaction({rules: [{path: 'x', strategy: 'mask'} as never]})).toThrow('closed plain data object')
		expect(() => createSpanRedaction({rules: Array(1)})).toThrow('dense data array')
		expect(() => createSpanRedaction({rules: [{key: '', action: 'mask'}]})).toThrow('1-256')
		expect(() => createSpanRedaction({rules: [{key: 'x'.repeat(257), action: 'mask'}]})).toThrow('1-256')
	})

	it('rejects oversized rule arrays before materializing every descriptor', () => {
		let descriptorReads = 0
		const rules = new Proxy(Array.from({length: 10_000}, () => ({key: 'safe', action: 'mask'})), {
			getOwnPropertyDescriptor: (target, key) => {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		expect(() => createSpanRedaction({rules})).toThrow('at most 1000')
		expect(descriptorReads).toBe(1)
	})

	it('rejects RegExp key rules that can cause catastrophic backtracking', () => {
		expect(() => createSpanRedaction({
			rules: [{key: /^(a+)+$/u, action: 'mask'}]
		})).toThrow('must not contain repetition')
		expect(() => createSpanRedaction({
			rules: [{key: new RegExp('a'.repeat(257), 'u'), action: 'mask'}]
		})).toThrow('1-256')
	})

	it('bounds regex matchers and preserves first-match ordering with compiled exact rules', () => {
		expect(() => createSpanRedaction({
			rules: Array.from({length: 65}, (_, index) => ({
				key: new RegExp(`^field-${index}$`, 'u'), action: 'mask' as const
			}))
		})).toThrow('at most 64 regular-expression keys')

		const regexFirst = createSpanRedaction({rules: [
			{key: /^tenant-id$/u, action: 'drop'},
			{key: 'tenant_id', action: 'mask'}
		]})
		const exactFirst = createSpanRedaction({rules: [
			{key: 'tenant_id', action: 'mask'},
			{key: /^tenant-id$/u, action: 'drop'}
		]})
		expect(regexFirst({'tenant-id': 'acme'})).toEqual({})
		expect(exactFirst({'tenant-id': 'acme'})).toEqual({'tenant-id': '***'})
	})

	it('does not invoke accessors or proxy regex traps at bootstrap', () => {
		let reads = 0
		const accessorRule = Object.defineProperty({}, 'key', {
			enumerable: true, get: () => { reads++; return 'secret' }
		})
		expect(() => createSpanRedaction({rules: [accessorRule as never]})).toThrow('closed plain data object')
		expect(reads).toBe(0)
		const hostile = new Proxy(/secret/u, {get: () => { reads++; throw new Error('trap') }})
		expect(() => createSpanRedaction({rules: [{key: hostile, action: 'mask'}]})).toThrow('key')
		expect(reads).toBe(0)
	})

	it('fails closed for hostile attributes and reports the failure', () => {
		const report = vi.fn()
		let ownKeysCalls = 0
		const hostile = new Proxy({}, {ownKeys: () => { ownKeysCalls++; throw new Error('keys') }})
		expect(maskAttributes(hostile)).toEqual({})
		expect(maskSpanAttributes(hostile)).toEqual({})
		expect(createSpanRedaction({errors: {report} as never})(hostile)).toEqual({})
		expect(report).toHaveBeenCalled()
		expect(ownKeysCalls).toBe(0)
	})

	it('never executes attribute accessors and rejects over-wide redaction graphs', () => {
		let reads = 0
		const nested = Object.defineProperty({}, 'secret', {
			enumerable: true, get: () => { reads++; return 'leaked' }
		})
		const redact = createSpanRedaction()

		expect(redact({nested} as never)).toEqual({})
		expect(reads).toBe(0)
		expect(redact(Object.fromEntries(
			Array.from({length: 401}, (_, index) => [`field-${index}`, 'value'])
		) as never)).toEqual({})
	})
})
