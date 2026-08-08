import {describe, expect, it, vi} from 'vitest'

import {
	sanitizeLoggingDiagnostic,
	sanitizeLoggingErrorDiagnostic
} from '../../src/utils/sanitize-diagnostic'

describe('sanitizeLoggingDiagnostic', () => {
	it('redacts secrets and URL credentials while bounding output', () => {
		const diagnostic = sanitizeLoggingDiagnostic(
			`Bearer abc.def token=secret user@example.com https://user:pass@example.com/path?apiKey=secret ${'x'.repeat(1_000)}`
		)
		expect(diagnostic).not.toContain('abc.def')
		expect(diagnostic).not.toContain('token=secret')
		expect(diagnostic).not.toContain('user@example.com')
		expect(diagnostic).not.toContain('user:pass')
		expect(diagnostic).not.toContain('apiKey=secret')
		expect(diagnostic.length).toBeLessThanOrEqual(513)
	})

	it('handles hostile string conversion', () => {
		const toString = vi.fn(() => 'token=must-not-run')
		expect(sanitizeLoggingDiagnostic({toString})).toBe('[unavailable]')
		expect(toString).not.toHaveBeenCalled()
	})

	it('reads Error diagnostics without invoking accessors or conversion hooks', () => {
		const message = vi.fn(() => 'token=must-not-run')
		const hostile = Object.defineProperty({toString: vi.fn()}, 'message', {get: message})
		expect(sanitizeLoggingErrorDiagnostic(hostile)).toBe('[unavailable]')
		expect(message).not.toHaveBeenCalled()
		expect(hostile.toString).not.toHaveBeenCalled()

		expect(sanitizeLoggingErrorDiagnostic(new Error('token=secret'))).toBe('token=[REDACTED]')
	})

	it('redacts quoted credentials and regulated identifiers', () => {
		const raw = '{"password":"open sesame","authorization":"Basic dXNlcjpwYXNz"} 123-45-6789 4111 1111 1111 1111 192.0.2.44'
		const diagnostic = sanitizeLoggingDiagnostic(raw)
		for (const secret of ['open sesame', 'dXNlcjpwYXNz', '123-45-6789', '4111', '192.0.2.44']) {
			expect(diagnostic).not.toContain(secret)
		}
	})

	it('redacts prefixed credential names', () => {
		const diagnostic = sanitizeLoggingDiagnostic(
			'client_secret=one dbPassword=two csrfToken=three tokenCount=4'
		)
		expect(diagnostic).not.toContain('one')
		expect(diagnostic).not.toContain('two')
		expect(diagnostic).not.toContain('three')
		expect(diagnostic).toContain('tokenCount=4')
	})
})
