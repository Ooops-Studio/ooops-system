import {describe, expect, it} from 'vitest'

import {TOK} from '../../src/tokens'

describe('events foundation contracts', () => {
	it('keeps event capability tokens globally stable', () => {
		expect(TOK.Events).toBe(Symbol.for('@ooopsstudio/events'))
		expect(TOK.EventsTransactional).toBe(Symbol.for('@ooopsstudio/events-transactional'))
		expect(TOK.EventsAdmin).toBe(Symbol.for('@ooopsstudio/events-admin'))
	})
})
