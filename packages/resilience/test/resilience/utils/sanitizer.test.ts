import {describe, expect, it, vi} from 'vitest'

import {
	describeResilienceError,
	fingerprintResilienceValue,
	sanitizeResilienceContext,
	sanitizeResilienceErrorType,
	sanitizeResilienceKeyPart,
	sanitizeResilienceResource
} from '../../../src/resilience/utils/sanitizer'

describe('resilience sanitizer', () => {
	it('normalizes resources and fingerprints unsafe identifiers', () => {
		expect(sanitizeResilienceResource()).toBe('unknown')
		expect(sanitizeResilienceResource('queue/42/orders')).toMatch(/^fp_/u)
		expect(sanitizeResilienceResource('job/550e8400-e29b-41d4-a716-446655440000')).toMatch(/^fp_/u)
		expect(sanitizeResilienceResource('api/orders?token=secret')).toMatch(/^fp_/u)
		expect(sanitizeResilienceResource('https://api.example.test/v1')).toMatch(/^fp_/u)
		expect(sanitizeResilienceResource('tenant-acme')).toMatch(/^fp_/u)
		expect(sanitizeResilienceResource('workspace:design-studio')).toMatch(/^fp_/u)
		expect(sanitizeResilienceResource('x'.repeat(65))).toMatch(/^fp_/u)
	})

	it('uses stable fingerprints and sanitizes all supported context fields', () => {
		const fingerprint = fingerprintResilienceValue('secret')
		expect(fingerprint).toBe(fingerprintResilienceValue('secret'))
		expect(sanitizeResilienceKeyPart('secret')).toBe(fingerprint)
		expect(sanitizeResilienceContext({
			resource: 'queue/12',
			tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a', correlationId: 'correlation-a',
			metadata: {token: 'value', attempts: 2, enabled: true}
		})).toMatchObject({
			resource: expect.stringMatching(/^fp_/u), tenantId: expect.stringMatching(/^fp_/u), workspaceId: expect.stringMatching(/^fp_/u),
			userId: expect.stringMatching(/^fp_/u), correlationId: expect.stringMatching(/^fp_/u),
			metadata: expect.objectContaining({
				[fingerprintResilienceValue('attempts')]: 2,
				[fingerprintResilienceValue('enabled')]: true
			})
		})
		expect(sanitizeResilienceContext({
			resource: 'tenant/acme@example.test?token=secret'
		}).resource).toMatch(/^fp_/u)
	})

	it('handles cyclic metadata, hostile strings and error descriptions safely', () => {
		const cyclic: {self?: unknown} = {}
		cyclic.self = cyclic
		expect(sanitizeResilienceContext({resource: 'job', metadata: {cyclic} as never}).metadata).toBeDefined()
		const hostile = {toString: () => { throw new Error('nope') }}
		expect(fingerprintResilienceValue(hostile)).toMatch(/^fp_/u)
		expect(fingerprintResilienceValue(`${'x'.repeat(70_000)}a`)).not.toBe(
			fingerprintResilienceValue(`${'x'.repeat(70_000)}b`)
		)
		expect(describeResilienceError(new Error('boom'))).toEqual({type: 'Error', message: 'boom'})
		expect(describeResilienceError('boom')).toEqual({type: 'string', message: 'boom'})
		expect(sanitizeResilienceErrorType('TimedOutError')).toBe('TimedOutError')
		expect(sanitizeResilienceErrorType('DatabasePasswordError')).toBe('ResilienceOperationError')
	})

	it('bounds metadata inspection and hostile error prototype traversal', () => {
		const metadata = Object.fromEntries(Array.from({length: 20_000}, (_, index) => [`field${index}`, index]))
		const bulkDescriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors')
		expect(sanitizeResilienceContext({resource: 'job', metadata} as never).metadata).toEqual({metadata: '[unavailable]'})
		expect(bulkDescriptors.mock.calls.some(([value]) => value === metadata)).toBe(false)
		bulkDescriptors.mockRestore()

		let prototypeReads = 0
		let cyclic!: object
		cyclic = new Proxy({}, {getPrototypeOf: () => { prototypeReads++; return cyclic }})
		expect(describeResilienceError(cyclic)).toEqual({type: 'object', message: '[unavailable]'})
		expect(prototypeReads).toBeLessThanOrEqual(33)

		let getterReads = 0
		const hostileContext = Object.defineProperty({}, 'resource', {
			enumerable: true, get: () => { getterReads++; return 'secret' }
		})
		expect(sanitizeResilienceContext(hostileContext as never).resource).toBe('unknown')
		expect(getterReads).toBe(0)
	})
})
