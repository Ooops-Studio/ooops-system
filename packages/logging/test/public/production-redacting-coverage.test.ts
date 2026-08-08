import {describe, expect, it, vi} from 'vitest'

import {createProductionRedacting} from '../../src/public/production-redacting'

describe('production redacting diagnostics', () => {
	it('accepts an optional errors port without exposing sensitive values', async() => {
		const errors = {report: vi.fn()}
		const redacting = await createProductionRedacting(errors as never)
		const record = await redacting({level: 'info', message: 'token=secret', time: 1})
		expect(record.message).not.toContain('secret')
	})

	it('does not emit reversible token fingerprints or card prefixes', async() => {
		const redacting = await createProductionRedacting()
		const record = await redacting({
			level: 'info', message: 'payment', time: 1,
			context: {attributes: {token: 'low-entropy-token', creditCard: '4111111111111111'}}
		})
		expect(record.context?.attributes?.token).toBe('***')
		expect(record.context?.attributes).not.toHaveProperty('creditCard')
		expect(JSON.stringify(record)).not.toContain('4111')
	})

	it('redacts raw client address attributes', async() => {
		const redacting = await createProductionRedacting()
		const record = await redacting({
			level: 'info', message: 'request', time: 1,
			context: {attributes: {
				ip: '192.0.2.10', ipAddress: '192.0.2.11',
				xForwardedFor: '192.0.2.12', 'x-forwarded-for': '192.0.2.13'
			}}
		})
		const serialized = JSON.stringify(record)
		expect(serialized).not.toContain('192.0.2.')
	})

	it('redacts JSON-like credentials and Basic authorization in free-form text', async() => {
		const redacting = await createProductionRedacting()
		const record = await redacting({
			level: 'error', time: 1,
			message: 'payload={"password":"open sesame","authorization":"Basic dXNlcjpwYXNz"} cookie=session-secret card=4111 1111 1111 1111 ssn=123-45-6789 ip=192.0.2.44'
		})
		expect(record.message).not.toContain('open sesame')
		expect(record.message).not.toContain('dXNlcjpwYXNz')
		expect(record.message).not.toContain('session-secret')
		expect(record.message).not.toContain('4111')
		expect(record.message).not.toContain('123-45-6789')
		expect(record.message).not.toContain('192.0.2.44')
		expect(record.message).toContain('[REDACTED]')
	})

	it('redacts prefixed credential keys without over-redacting operational counters', async() => {
		const redacting = await createProductionRedacting()
		const clientSecret = 'client-secret-value'
		const databasePassword = 'database-password-value'
		const csrfToken = 'csrf-token-value'
		const record = await redacting({
			level: 'error',
			time: 1,
			message: `client_secret=${clientSecret} dbPassword=${databasePassword} csrfToken=${csrfToken}`,
			context: {attributes: {
				client_secret: clientSecret,
				dbPassword: databasePassword,
				csrfToken,
				tokenCount: 4
			}}
		})

		expect(record.message).not.toContain(clientSecret)
		expect(record.message).not.toContain(databasePassword)
		expect(record.message).not.toContain(csrfToken)
		expect(record.context?.attributes).toMatchObject({
			client_secret: '***',
			dbPassword: '***',
			csrfToken: '***',
			tokenCount: 4
		})
	})
})
