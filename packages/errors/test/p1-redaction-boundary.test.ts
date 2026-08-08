import {describe, expect, it} from 'vitest'

import {createCustomErrorHandler} from '../src/public/custom'
import {createSentryEvent} from '../src/sinks/providers/sentry-event'
import {
	sanitizeSentryTags,
	sanitizeSentryTagValue
} from '../src/sinks/providers/sentry-sanitization'
import {redactErrorValue} from '../src/utils/redaction'

describe('P1 redaction boundary regressions', () => {
	it('does not trust caller-controlled values that resemble internal hashes', () => {
		const redacted = redactErrorValue({
			tenantId: 'hash:deadbeef',
			requestId: 'hash:cafebabe'
		}) as Record<string, unknown>

		expect(redacted.tenantId).toMatch(/^hash:[0-9a-f]{8}$/u)
		expect(redacted.requestId).toMatch(/^hash:[0-9a-f]{8}$/u)
		expect(JSON.stringify(redacted)).not.toMatch(/deadbeef|cafebabe/u)
	})

	it('does not trust caller-controlled values that resemble sanitized Sentry tags', () => {
		for (const [key, value] of [
			['tenantId', 'id:secret'],
			['billingPhone', 'pii:secret'],
			['serverName', 'server:secret'],
			['source', 'source:secret']
		] as const) {
			const sanitized = sanitizeSentryTagValue(key, value)
			expect(sanitized).not.toBe(value)
			expect(sanitized).not.toContain('secret')
		}
	})

	it('keeps trusted sanitized tag objects idempotent without string-prefix trust', () => {
		const sanitized = sanitizeSentryTags({tenantId: 'id:secret', source: 'source:secret'})

		expect(sanitizeSentryTags(sanitized)).toBe(sanitized)
		expect(JSON.stringify(sanitized)).not.toContain('secret')
		expect(Object.isFrozen(sanitized)).toBe(true)
	})

	it('blocks forged fingerprints across the public handler and Sentry event boundaries', async() => {
		let reported: unknown
		const handler = await createCustomErrorHandler({
			report: async(error) => { reported = error }
		})
		const handled = await handler.handle(new Error('safe'), {
			tenantId: 'hash:deadbeef', requestId: 'hash:cafebabe'
		})
		const event = createSentryEvent(handled, {
			tags: {tenantId: 'id:secret', source: 'source:secret'}
		})
		const diagnostic = JSON.stringify({handled, reported, event})

		expect(diagnostic).not.toMatch(/deadbeef|cafebabe|id:secret|source:secret/u)
	})
})
