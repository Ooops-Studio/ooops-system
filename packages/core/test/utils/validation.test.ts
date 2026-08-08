import {describe, expect, it, vi} from 'vitest'

import {normalizeError} from '../../src/utils/error/normalize-error'
import {
	ConfigValidationError,
	validateFiniteNumber,
	validateNonNegativeFinite,
	validateNonNegativeInteger,
	validateNumberInRange,
	validatePositiveFinite,
	validatePositiveInteger,
	validateHeaders,
	validateUrl,
	snapshotDenseDataArray,
	snapshotPlainDataRecord
} from '../../src/utils/validation'

describe('configuration validation', () => {
	it('does not coerce hostile validation error messages', () => {
		const coerce = vi.fn(() => 'hostile')
		const error = new ConfigValidationError({[Symbol.toPrimitive]: coerce} as never)

		expect(error.message).toBe('Invalid configuration')
		expect(coerce).not.toHaveBeenCalled()
		expect(() => validateFiniteNumber('bad', 'x'.repeat(1_000_000))).toThrow(/^value must/u)
	})

	it('preserves URL and header validation after parsing intrinsics are rewired', () => {
		const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'URL')!
		const testDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')!
		const includesDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'includes')!
		const poison = (): never => { throw new Error('poisoned validation intrinsic') }
		try {
			Object.defineProperty(globalThis, 'URL', {configurable: true, writable: true, value: poison})
			Object.defineProperty(RegExp.prototype, 'test', {configurable: true, writable: true, value: poison})
			Object.defineProperty(String.prototype, 'includes', {configurable: true, writable: true, value: poison})
			expect(() => validateUrl('https://example.com', 'endpoint')).not.toThrow()
			expect(() => validateHeaders({'x-safe': 'value'})).not.toThrow()
		} finally {
			Object.defineProperty(globalThis, 'URL', urlDescriptor)
			Object.defineProperty(RegExp.prototype, 'test', testDescriptor)
			Object.defineProperty(String.prototype, 'includes', includesDescriptor)
		}
	})

	it('preserves own configuration fields under wide prototype pollution', () => {
		const polluted: string[] = []
		let headersFailure: unknown
		let snapshot: Record<string, unknown> | undefined
		try {
			for (let index = 0; index < 300; index += 1) {
				const key = `polluted_config_${index}`
				polluted.push(key)
				Object.defineProperty(Object.prototype, key, {
					configurable: true, enumerable: true, value: 'forged'
				})
			}
			try { validateHeaders({'x-safe': 'value'}) }
			catch(error) { headersFailure = error }
			snapshot = snapshotPlainDataRecord({endpoint: 'safe'}, new Set(['endpoint']), ['endpoint'])
		} finally {
			for (const key of polluted) delete (Object.prototype as Record<string, unknown>)[key]
		}

		expect(headersFailure).toBeUndefined()
		expect(snapshot).toEqual({endpoint: 'safe'})
		expect(Object.getPrototypeOf(snapshot)).toBeNull()
	})

	it('contains rejected promises stored in required field lists', async() => {
		const required = Promise.reject(new Error('required field rejected'))
		expect(snapshotPlainDataRecord(
			{endpoint: 'safe'}, new Set(['endpoint']), [required as never]
		)).toBeUndefined()
		await Promise.resolve()
	})

	it('describes hostile values without invoking coercion hooks', () => {
		let coercions = 0
		const hostile = {[Symbol.toPrimitive]: () => { coercions++; return 1 }}
		for (const validate of [
			validateFiniteNumber,
			validateNonNegativeFinite,
			validateNonNegativeInteger,
			validatePositiveFinite,
			validatePositiveInteger
		]) expect(() => validate(hostile, 'value')).toThrow('got: object')
		expect(() => validateNumberInRange(hostile, 'value', 0, 1)).toThrow('got: object')
		expect(coercions).toBe(0)
	})

	it('rejects invalid range bounds instead of bypassing the range check', () => {
		for (const [min, max] of [
			[Number.NaN, 10], [0, Number.NaN],
			[Number.NEGATIVE_INFINITY, 10], [0, Number.POSITIVE_INFINITY], [10, 0]
		]) {
			expect(() => validateNumberInRange(1_000_000, 'limit', min, max))
				.toThrow('range bounds')
		}
		expect(() => validateNumberInRange(10, 'limit', 0, 10)).not.toThrow()
	})

	it('does not stringify bigint validation or error payloads', () => {
		const stringify = vi.spyOn(BigInt.prototype, 'toString')
		expect(() => validatePositiveInteger(1n, 'value')).toThrow('got: bigint')
		expect(normalizeError(1n)).toMatchObject({message: '[BigInt]'})
		expect(normalizeError({name: 'Failure', message: 'bad', data: {value: 1n}}).data)
			.toMatchObject({value: '[BigInt]'})
		expect(stringify).not.toHaveBeenCalled()
	})

	it('normalizes symbol-wide error data without materializing all keys', () => {
		const symbols = Object.fromEntries(Array.from(
			{length: 10_000}, (_, index) => [Symbol(`hidden-${index}`), index]
		))
		const enumerateKeys = vi.spyOn(Reflect, 'ownKeys').mockImplementation(() => [])
		let normalized: ReturnType<typeof normalizeError>
		let enumerationCalls = 0
		try {
			normalized = normalizeError({name: 'Failure', message: 'bad', data: symbols})
			enumerationCalls = enumerateKeys.mock.calls.length
		} finally { enumerateKeys.mockRestore() }
		expect(normalized!.data).toEqual({})
		expect(enumerationCalls).toBe(0)
	})

	it('does not invoke accessor-backed native error fields', () => {
		let reads = 0
		const error = Object.defineProperties(new Error('safe'), {
			stack: {configurable: true, get: () => { reads++; return 'secret stack' }},
			code: {configurable: true, get: () => { reads++; return 'SECRET' }}
		})
		const normalized = normalizeError(error)
		expect(normalized).toMatchObject({message: 'safe'})
		expect(normalized).not.toHaveProperty('stack')
		expect(normalized).not.toHaveProperty('code')
		expect(reads).toBe(0)
	})

	it('does not trust proxied native getters on error fields', () => {
		let reads = 0
		const nativeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!
		const disguised = new Proxy(nativeGetter, {
			apply: () => { reads++; return 'secret stack' }
		})
		const error = Object.defineProperty(new Error('safe'), 'stack', {
			configurable: true,
			get: disguised
		})

		expect(normalizeError(error)).toMatchObject({message: 'safe'})
		expect(normalizeError(error)).not.toHaveProperty('stack')
		expect(reads).toBe(0)
	})

	it('does not reflect invalid URL contents into configuration errors', () => {
		const secret = 'secret-token-value'
		let message = ''
		try { validateUrl(`not-a-url?token=${secret}`, 'endpoint') } catch(error) {
			message = (error as Error).message
		}

		expect(message).toContain('endpoint must be a valid URL')
		expect(message).not.toContain(secret)
		expect(() => validateUrl('x'.repeat(4_097), 'endpoint')).toThrow('at most 4096')
	})

	it('validates headers without invoking accessors or retaining oversized values', () => {
		let reads = 0
		const accessor = Object.create(null) as Record<string, string>
		Object.defineProperty(accessor, 'authorization', {
			enumerable: true,
			get() { reads += 1; return 'Bearer secret' }
		})

		expect(() => validateHeaders(accessor)).toThrow('bounded string data properties')
		expect(reads).toBe(0)
		expect(() => validateHeaders({authorization: 'x'.repeat(8_193)})).toThrow('bounded string')
		expect(() => validateHeaders({'bad header': 'value'})).toThrow('bounded string')
		expect(() => validateHeaders({authorization: 'safe\r\ninjected: true'})).toThrow('bounded string')
		expect(() => validateHeaders({emoji: '😀'.repeat(2_049)})).toThrow('bounded string')
	})

	it('applies collection bounds before materializing descriptor maps', () => {
		const descriptorMaps = vi.spyOn(Object, 'getOwnPropertyDescriptors')
		try {
			expect(snapshotDenseDataArray(new Array(1_000_000), 10)).toBeUndefined()
			const headers = Object.fromEntries(
				Array.from({length: 10_000}, (_, index) => [`x-${index}`, 'value'])
			)
			expect(() => validateHeaders(headers)).toThrow('at most 256')
			const record = Object.fromEntries(Array.from({length: 10_000}, (_, index) => [`x-${index}`, index]))
			expect(snapshotPlainDataRecord(
				record,
				new Set(['allowed'])
			)).toBeUndefined()
			expect(descriptorMaps.mock.calls.some(([value]) => value === headers || value === record)).toBe(false)
		} finally { descriptorMaps.mockRestore() }
	})

	it('rejects proxy records before executing enumeration traps', () => {
		const ownKeys = vi.fn(() => ['authorization'])
		const getOwnPropertyDescriptor = vi.fn(() => undefined)
		const headers = new Proxy({authorization: 'safe'}, {ownKeys, getOwnPropertyDescriptor})
		const values = new Proxy(['safe'], {ownKeys, getOwnPropertyDescriptor})

		expect(() => validateHeaders(headers)).toThrow('bounded string')
		expect(snapshotPlainDataRecord(headers, new Set(['authorization']))).toBeUndefined()
		expect(snapshotDenseDataArray(values, 1)).toBeUndefined()
		expect(ownKeys).not.toHaveBeenCalled()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('does not invoke caller-overridden Set and Array policy methods', () => {
		const has = vi.fn(() => false)
		const some = vi.fn(() => true)
		const allowed = new Set(['authorization'])
		Object.defineProperty(allowed, 'has', {value: has})
		const required = ['authorization']
		Object.defineProperty(required, 'some', {value: some})

		expect(snapshotPlainDataRecord(
			{authorization: 'safe'}, allowed, required
		)).toEqual({authorization: 'safe'})
		expect(has).not.toHaveBeenCalled()
		expect(some).not.toHaveBeenCalled()
	})
})
