import {describe, expect, it} from 'vitest'

import {TOK} from '../../src/tokens'

describe('Jobs core contracts', () => {
	it('keeps stable cross-package token identities', () => {
		expect(TOK.Jobs).toBe(Symbol.for('@ooopsstudio/jobs'))
		expect(TOK.JobsAdmin).toBe(Symbol.for('@ooopsstudio/jobs-admin'))
	})

	it('keeps normal and administrative capabilities distinct', () => {
		expect(TOK.Jobs).not.toBe(TOK.JobsAdmin)
	})
})
