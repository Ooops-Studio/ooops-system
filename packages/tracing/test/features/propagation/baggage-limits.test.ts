/**
 * @file Tests for baggage limits.
 */

import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import {describe, it, expect, vi} from 'vitest'

import {applyBaggageLimits, exceedsBaggageLimits} from '../../../src/features/propagation/baggage-limits'

describe('applyBaggageLimits', () => {
	it('ignores symbol-only fields without materializing a symbol-key array', () => {
		const symbols = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`hidden-${index}`), index]
		))
		const enumerateSymbols = vi.spyOn(Object, 'getOwnPropertySymbols')
			.mockImplementation(() => [])
		let limited: LogAttributes
		let exceeds: boolean
		let enumerationCalls = 0
		try {
			limited = applyBaggageLimits(symbols)
			exceeds = exceedsBaggageLimits(symbols)
			enumerationCalls = enumerateSymbols.mock.calls.length
		} finally { enumerateSymbols.mockRestore() }
		expect(limited!).toEqual({})
		expect(exceeds!).toBe(false)
		expect(enumerationCalls).toBe(0)
	})

	it('rejects invalid limit options', () => {
		let coercions = 0
		const hostile = {[Symbol.toPrimitive]: () => { coercions++; return 1 }}
		expect(() => applyBaggageLimits({}, {maxBytes: hostile as never})).toThrow('positive integer')
		expect(() => applyBaggageLimits({}, {maxKeys: hostile as never})).toThrow('positive integer')
		expect(coercions).toBe(0)
		expect(() => applyBaggageLimits({}, {maxBytes: Number.NaN})).toThrow('maxBytes must be a positive integer')
		expect(() => exceedsBaggageLimits({}, {maxKeys: 0})).toThrow('maxKeys must be a positive integer')
		expect(() => applyBaggageLimits({}, {maxBytes: 1_000_001})).toThrow('at most 1000000')
		expect(() => applyBaggageLimits({}, {maxKeys: 10_001})).toThrow('at most 10000')
		const getter = vi.fn(() => 1)
		const accessor = Object.defineProperty({}, 'maxBytes', {enumerable: true, get: getter})
		expect(() => applyBaggageLimits({}, accessor)).toThrow('closed plain data object')
		expect(getter).not.toHaveBeenCalled()
	})

	it('should apply key count limits', () => {

		const attrs: Record<string, string> = {}
		for (let i = 0; i < 20; i++) {
			attrs[`key${i}`] = `value${i}`
		}

		const result = applyBaggageLimits(attrs as LogAttributes, {maxKeys: 10})

		expect(Object.keys(result).length).toBeLessThanOrEqual(10)
	})

	it('should apply byte size limits', () => {

		const attrs: LogAttributes = {
			large: 'x'.repeat(200)
		}

		const result = applyBaggageLimits(attrs, {maxBytes: 50})

		// Should truncate or drop
		if (result.large) {
			expect(String(result.large).length).toBeLessThan(200)
		}
	})

	it('should truncate string values when exceeding byte limit', () => {

		const attrs: LogAttributes = {
			key: 'x'.repeat(100)
		}

		const result = applyBaggageLimits(attrs, {maxBytes: 50})

		if (result.key) {
			const value = String(result.key)
			expect(value).toContain('[TRUNCATED]')
			expect(value.length).toBeLessThan(100)
		}
	})

	it('should preserve attributes within limits', () => {

		const attrs: LogAttributes = {
			key1: 'value1',
			key2: 'value2',
			key3: 'value3'
		}

		const result = applyBaggageLimits(attrs, {maxKeys: 10, maxBytes: 1000})

		expect(result.key1).toBe('value1')
		expect(result.key2).toBe('value2')
		expect(result.key3).toBe('value3')
		expect(applyBaggageLimits({'trace!key': 'value'})).toEqual({'trace!key': 'value'})
	})

	it('should handle empty attributes', () => {

		const result = applyBaggageLimits({})

		expect(Object.keys(result).length).toBe(0)
		expect(applyBaggageLimits({nil: null, yes: true, no: false, count: 2})).toEqual({
			nil: 'null', yes: 'true', no: 'false', count: '2'
		})
		expect(applyBaggageLimits({invalid: Number.NaN})).toEqual({})
		expect(exceedsBaggageLimits({invalid: Number.NaN})).toBe(true)
		expect(applyBaggageLimits([] as never)).toEqual({})
	})

	it('counts percent-encoded bytes and never splits Unicode surrogate pairs', () => {
		const result = applyBaggageLimits({emoji: '😀'.repeat(20)}, {maxBytes: 60})
		if (result.emoji) {
			expect(() => encodeURIComponent(String(result.emoji))).not.toThrow()
			expect(Buffer.byteLength(`emoji=${encodeURIComponent(String(result.emoji))}`)).toBeLessThanOrEqual(60)
		}
	})

	it('drops unsafe keys and hostile values without displacing valid baggage', () => {
		let toStringCalls = 0
		const hostile = {toString: () => { toStringCalls++; throw new Error('hostile') }}
		const result = applyBaggageLimits({
			'bad key': 'ignored', __proto__: 'ignored', hostile, valid: 'kept'
		} as never, {maxBytes: 100, maxKeys: 1})
		expect(result).toEqual({valid: 'kept'})
		expect(toStringCalls).toBe(0)
	})

	it('bounds very large values without percent-encoding the complete input', () => {
		const originalEncode = globalThis.encodeURIComponent
		const encode = vi.spyOn(globalThis, 'encodeURIComponent').mockImplementation((value) => originalEncode(value))
		try {
			const payload = '😀'.repeat(1_000_000)
			const result = applyBaggageLimits({payload})
			expect(Buffer.byteLength(`payload=${encodeURIComponent(String(result.payload ?? ''))}`)).toBeLessThanOrEqual(8_192)
			expect(exceedsBaggageLimits({payload})).toBe(true)
			expect(Math.max(...encode.mock.calls.map(([value]) => value.length))).toBeLessThanOrEqual(8_192)
		} finally { encode.mockRestore() }
	})

	it('fails closed without invoking accessor-backed baggage values', () => {
		let getterCalls = 0
		const baggage = Object.defineProperty({safe: 'value'}, 'secret', {
			enumerable: true,
			get: () => { getterCalls++; return 'must-not-read' }
		})
		expect(applyBaggageLimits(baggage as never)).toEqual({})
		expect(exceedsBaggageLimits(baggage as never)).toBe(true)
		expect(getterCalls).toBe(0)
		const hostileContainer = new Proxy({}, {ownKeys: () => { throw new Error('ownKeys') }})
		expect(applyBaggageLimits(hostileContainer as never)).toEqual({})
		expect(exceedsBaggageLimits(hostileContainer as never)).toBe(true)
	})

	it('rejects inherited baggage containers before enumerating prototype fields', () => {
		let getterCalls = 0
		const prototype = Object.defineProperty({}, 'inherited', {
			enumerable: true,
			get: () => { getterCalls++; return 'secret' }
		})
		const baggage = Object.assign(Object.create(prototype) as Record<string, unknown>, {safe: 'value'})

		expect(applyBaggageLimits(baggage as never)).toEqual({})
		expect(exceedsBaggageLimits(baggage as never)).toBe(true)
		expect(getterCalls).toBe(0)
	})

	it('bounds descriptor inspection for very wide baggage objects', () => {
		const wide = Object.fromEntries(Array.from({length: 1_000}, (_, index) => [`key${index}`, `value${index}`]))
		let descriptorReads = 0
		const observed = new Proxy(wide, {
			getOwnPropertyDescriptor: (target, key) => {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		// Proxy containers fail closed before ownKeys can materialize the complete
		// attacker-controlled key list.
		expect(applyBaggageLimits(observed, {maxKeys: 1})).toEqual({})
		expect(descriptorReads).toBe(0)
		expect(exceedsBaggageLimits(observed, {maxKeys: 1})).toBe(true)
	})
})

describe('exceedsBaggageLimits', () => {

	it('should detect key count violations', () => {

		const attrs: Record<string, string> = {}
		for (let i = 0; i < 20; i++) {
			attrs[`key${i}`] = `value${i}`
		}

		expect(exceedsBaggageLimits(attrs as LogAttributes, {maxKeys: 10})).toBe(true)
		expect(exceedsBaggageLimits(attrs as LogAttributes, {maxKeys: 30})).toBe(false)
	})

	it('should detect byte size violations', () => {

		const attrs: LogAttributes = {
			large: 'x'.repeat(200)
		}

		expect(exceedsBaggageLimits(attrs, {maxBytes: 50})).toBe(true)
		expect(exceedsBaggageLimits(attrs, {maxBytes: 1000})).toBe(false)
	})

	it('should return false for attributes within limits', () => {

		const attrs: LogAttributes = {
			key1: 'value1',
			key2: 'value2'
		}

		expect(exceedsBaggageLimits(attrs, {maxKeys: 10, maxBytes: 1000})).toBe(false)
	})
})
