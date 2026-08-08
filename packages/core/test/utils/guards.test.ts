import {describe, expect, it, vi} from 'vitest'

import {isPlainObject, safeStringify} from '../../src/utils/guards'

describe('guard utilities', () => {
	it('keeps safeStringify non-throwing for hostile coercion fallbacks', () => {
		const hostile = {
			toJSON() { throw new Error('serialization failed') },
			[Symbol.toPrimitive]() { throw new Error('coercion failed') }
		}

		expect(() => safeStringify(hostile)).not.toThrow()
		expect(safeStringify(hostile)).toBe('{}')
	})

	it('bounds sparse arrays instead of expanding their logical length', () => {
		expect(safeStringify(new Array(1_001))).toBe('"[Circular or non-serializable]"')
	})

	it('rejects revoked proxies without leaking proxy trap failures', () => {
		const {proxy, revoke} = Proxy.revocable({}, {})
		revoke()

		expect(() => isPlainObject(proxy)).not.toThrow()
		expect(isPlainObject(proxy)).toBe(false)
	})

	it('rejects live proxies before prototype traps', () => {
		const getPrototypeOf = vi.fn(() => Object.prototype)
		const proxy = new Proxy({}, {getPrototypeOf})

		expect(isPlainObject(proxy)).toBe(false)
		expect(getPrototypeOf).not.toHaveBeenCalled()
	})
})
