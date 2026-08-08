import {describe, expect, it} from 'vitest'

import {applyRulesSafe} from '../../../src/features/redacting/apply-rules'

describe('managed redaction rules', () => {
	it('matches normalized keys and exact array paths', () => {
		const output = applyRulesSafe({
			api_token: 'secret',
			profile: {name: 'abcdef', untouched: true}
		}, [
			{key: 'api-token', action: 'hash'},
			{path: ['profile', 'name'], action: 'truncate', maxBytes: 3}
		]) as Record<string, unknown>
		expect(output.api_token).toMatch(/^[a-f0-9]{8}$/u)
		expect(output.profile).toEqual({name: 'abc…', untouched: true})
	})

	it('supports regex keys and drop without mutating the input', () => {
		const input = {headers: {authorization: 'secret', keep: 'yes'}}
		const output = applyRulesSafe(input, [{key: /^authorization$/iu, action: 'drop'}])
		expect(output).toEqual({headers: {keep: 'yes'}})
		expect(input.headers.authorization).toBe('secret')
	})
})
