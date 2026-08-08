import {describe, expect, it} from 'vitest'

import {sanitizeUrlForDiagnostics} from '../../src/utils/sanitize-url'

describe('sanitizeUrlForDiagnostics', () => {
	it('strips credentials, query, and hash from valid URLs', () => {
		expect(sanitizeUrlForDiagnostics('https://user:pass@example.com/path?token=secret#hash'))
			.toBe('https://example.com')
	})

	it('does not retain any caller-controlled material from malformed URLs', () => {
		expect(sanitizeUrlForDiagnostics('not a url user:pass@example.com/path?token=secret#hash'))
			.toBe('[invalid-url]')
	})
})
