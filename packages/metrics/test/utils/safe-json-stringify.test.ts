import {describe, expect, it, vi} from 'vitest'

import {snapshotPresetOptions} from '../../src/public/preset-options'
import {safeJsonStringify} from '../../src/utils/safe-json-stringify'

describe('safe metrics serialization boundaries', () => {
	it('encodes own data without consulting inherited toJSON hooks', () => {
		const inheritedToJSON = vi.fn(() => 'compromised')
		Object.defineProperty(Array.prototype, 'toJSON', {
			configurable: true, value: inheritedToJSON
		})
		try {
			expect(safeJsonStringify({items: ['safe']})).toBe('{"items":["safe"]}')
			expect(inheritedToJSON).not.toHaveBeenCalled()
		} finally {
			Reflect.deleteProperty(Array.prototype, 'toJSON')
		}
	})

	it('rejects oversized option keys before hashing them in the allowlist', () => {
		const oversized = 'x'.repeat(1_000_000)
		const has = vi.spyOn(Set.prototype, 'has')
		try {
			expect(() => snapshotPresetOptions({[oversized]: true}, new Set(['enabled']), 'Test options'))
				.toThrow('stable known data fields')
			expect(has.mock.calls.some(([key]) => key === oversized)).toBe(false)
		} finally {
			has.mockRestore()
		}
	})
})
