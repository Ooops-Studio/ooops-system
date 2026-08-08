import {afterEach, describe, expect, it, vi} from 'vitest'

import {generateErrorId} from '../../src/utils/error-id'

describe('generateErrorId', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('prefers randomUUID', () => {
		const uuid = '123e4567-e89b-42d3-a456-426614174000'
		vi.stubGlobal('crypto', {randomUUID: () => uuid})
		expect(generateErrorId()).toBe(uuid)
	})

	it('rejects malformed randomUUID polyfill results', () => {
		const getRandomValues = (bytes: Uint8Array): Uint8Array => {
			bytes[0] = 1
			return bytes
		}
		vi.stubGlobal('crypto', {randomUUID: () => 42, getRandomValues})
		expect(generateErrorId()).toMatch(/^01[0]{30}$/u)
		vi.stubGlobal('crypto', {randomUUID: () => 'x'.repeat(100_000), getRandomValues})
		expect(generateErrorId()).toMatch(/^01[0]{30}$/u)
	})

	it('uses random bytes when randomUUID is unavailable or throws', () => {
		const getRandomValues = (bytes: Uint8Array): Uint8Array => {
			bytes[0] = 1
			return bytes
		}
		vi.stubGlobal('crypto', {randomUUID: () => { throw new Error('unavailable') }, getRandomValues})
		expect(generateErrorId()).toMatch(/^01[0]{30}$/u)
	})

	it('falls back when Web Crypto is absent, empty, or throws', () => {
		vi.spyOn(Date, 'now').mockReturnValue(1)
		vi.spyOn(Math, 'random').mockReturnValue(0.5)
		vi.stubGlobal('crypto', {getRandomValues: () => { throw new Error('unavailable') }})
		expect(generateErrorId()).toContain('-')
		vi.stubGlobal('crypto', {getRandomValues: (bytes: Uint8Array) => bytes})
		expect(generateErrorId()).toContain('-')
	})

	it('returns undefined when every source fails', () => {
		vi.stubGlobal('crypto', undefined)
		vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('unavailable') })
		expect(generateErrorId()).toBeUndefined()
	})
})
