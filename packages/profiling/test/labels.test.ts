import {describe, expect, it, vi} from 'vitest'

import {sanitizeProfileLabels} from '../src/labels'

describe('profiling label safety', () => {
	it('redacts common secret and PII key aliases', () => {
		expect(sanitizeProfileLabels({
			auth: 'hunter2',
			passwd: 'short-secret',
			pwd: 'another-secret',
			otp: '123456',
			user_name: 'Ada Lovelace',
			ip_address: '192.0.2.1',
			iban: 'DE89370400440532013000',
			route: '/orders/1234567890'
		})).toEqual({
			auth: 'redacted',
			passwd: 'redacted',
			pwd: 'redacted',
			otp: 'redacted',
			user_name: 'redacted',
			ip_address: 'redacted',
			iban: 'redacted',
			route: '/orders/:id'
		})
	})

	it('redacts credential assignments under neutral keys', () => {
		expect(sanitizeProfileLabels({detail: 'pwd=hunter2', challenge: 'otp:123456'})).toEqual({
			detail: 'redacted',
			challenge: 'redacted'
		})
	})

	it('redacts IP addresses even under otherwise innocuous keys', () => {
		expect(sanitizeProfileLabels({client: '192.0.2.42', peer: '2001:db8::1', route: '/clients/192.0.2.42'})).toEqual({
			client: '[ip]',
			peer: '[ip]',
			route: '/clients/:id'
		})
	})

	it('redacts phone-like PII in values and route segments', () => {
		expect(sanitizeProfileLabels({contact: '+1 (202) 555-0100', route: '/contacts/%2B12025550100'})).toEqual({
			contact: '[phone]',
			route: '/contacts/:id'
		})
	})

	it('redacts AWS access-key IDs under neutral labels and in paths', () => {
		expect(sanitizeProfileLabels({build: 'AKIAIOSFODNN7EXAMPLE', route: '/builds/ASIAIOSFODNN7EXAMPLE'})).toEqual({
			build: 'redacted',
			route: '/builds/:id'
		})
	})

	it('redacts repeatedly encoded PII and unresolved encoded segments', () => {
		expect(sanitizeProfileLabels({
			route: '/users/alice%2540example.com',
			lookup: 'alice%252540example.com',
			opaque: '/lookup/%252525252561'
		})).toEqual({
			route: '/users/:id',
			lookup: ':id',
			opaque: '/lookup/:id'
		})
	})

	it('does not trust a rewired global URL constructor while sanitizing labels', () => {
		vi.stubGlobal('URL', class {pathname = '/public/authorization=secret'})
		try {
			expect(sanitizeProfileLabels({route: 'https://example.test/users/alice@example.com'}))
				.toEqual({route: '/users/:id'})
		} finally { vi.unstubAllGlobals() }
	})

	it('does not trust a rewired global URI decoder while sanitizing path PII', () => {
		vi.stubGlobal('decodeURIComponent', () => 'public')
		try {
			expect(sanitizeProfileLabels({route: '/users/operator@example.com'}))
				.toEqual({route: '/users/:id'})
		} finally { vi.unstubAllGlobals() }
	})
})
