import {describe, expect, it} from 'vitest'

import {createIsolationKey, parseIsolationKey} from '../../../src/resilience/core/state-isolation'

describe('state-isolation', () => {

	it('creates and parses valid isolation keys', () => {

		const key = createIsolationKey('postgres.main', 'workspace', 'ws-123')
		expect(key).toMatch(/^fp_[0-9a-f]{64}::workspace:fp_[0-9a-f]{64}$/)
		expect(key).not.toContain('postgres.main')
		expect(key).not.toContain('ws-123')
		expect(parseIsolationKey(key)).toEqual({
			resource: expect.stringMatching(/^fp_[0-9a-f]{64}$/),
			scope: 'workspace',
			id: expect.stringMatching(/^fp_[0-9a-f]{64}$/)
		})

	})

	it('keeps lossy observability aliases distinct in identity keys', () => {
		const first = createIsolationKey('db:1', 'tenant', 'same-tenant')
		const second = createIsolationKey('db:2', 'tenant', 'same-tenant')

		expect(first).not.toBe(second)
	})

	it('rejects missing parts and invalid scopes', () => {

		expect(() => createIsolationKey('', 'workspace', 'id')).toThrow(/resource, scope, and id are required/i)
		expect(() => createIsolationKey('postgres.main', 'invalid' as never, 'id')).toThrow(/scope must be one of/i)
		try {
			createIsolationKey('', 'workspace', 'secret-tenant-id')
		} catch(error) {
			expect(String(error)).not.toContain('secret-tenant-id')
		}

	})

	it('returns null for malformed isolation keys', () => {

		expect(parseIsolationKey('broken' as never)).toBeNull()
		expect(parseIsolationKey('postgres.main::' as never)).toBeNull()
		expect(parseIsolationKey('postgres.main::workspace' as never)).toBeNull()
		expect(parseIsolationKey('postgres.main::invalid:id' as never)).toBeNull()
		expect(parseIsolationKey('postgres.main::workspace:' as never)).toBeNull()
		expect(parseIsolationKey('::workspace:id' as never)).toBeNull()
		expect(parseIsolationKey('x'.repeat(1_000_000) as never)).toBeNull()

	})

})
