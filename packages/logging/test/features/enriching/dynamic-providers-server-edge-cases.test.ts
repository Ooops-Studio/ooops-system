/**
 * @file Edge case tests for server dynamic provider.
 */

import type {RuntimeContext} from '@ooopsstudio/core/contracts/context'
import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import {getContext} from '@ooopsstudio/core/runtime/context'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createServerDynamicProvider} from '../../../src/features/enriching/dynamic-providers/server'

vi.mock('@ooopsstudio/core/runtime/context', () => ({
	getContext: vi.fn()
}))

describe('Server Dynamic Provider Edge Cases', () => {
	const originalEnvironment = process.env

	beforeEach(() => {
		vi.resetAllMocks()
		process.env = {}
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		process.env = originalEnvironment
	})

	it('should handle missing async context gracefully', async() => {
		vi.mocked(getContext).mockReturnValue(undefined)

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs).toEqual({})
	})

	it('supports server runtimes without a Node process global', async() => {
		vi.stubGlobal('process', undefined)
		try {
			const provider = createServerDynamicProvider()
			const attrs = await provider({level: 'info', message: 'test', time: 1})
			expect(attrs).toEqual({})
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('should handle context with correlationId but no userId', async() => {
		const context: RuntimeContext = {
			correlationId: 'test-correlation-id'
		}
		vi.mocked(getContext).mockReturnValue(context)

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.requestId).toBe('test-correlation-id')
		expect(attrs.userId).toBeUndefined()
	})

	it('should reject userId with dots (likely a token)', async() => {
		const context: RuntimeContext = {
			correlationId: 'test-correlation-id',
			userId: 'jwt.token.here'
		}
		vi.mocked(getContext).mockReturnValue(context)

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.userId).toBeUndefined() // Should not include token-like userId
	})

	it('should accept safe userId without dots', async() => {
		const context: RuntimeContext = {
			correlationId: 'test-correlation-id',
			userId: 'user123'
		}
		vi.mocked(getContext).mockReturnValue(context)

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.userId).toBe('user123')
	})

	it('should extract instanceId from environment variables', async() => {
		process.env.INSTANCE_ID = 'instance-123'

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.instanceId).toBe('instance-123')
	})

	it('should fallback to HOSTNAME if INSTANCE_ID not set', async() => {
		process.env.HOSTNAME = 'hostname-123'

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.instanceId).toBe('hostname-123')
	})

	it('should extract region from environment variables', async() => {
		process.env.REGION = 'us-east-1'

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.region).toBe('us-east-1')
	})

	it('should fallback to AWS_REGION if REGION not set', async() => {
		process.env.AWS_REGION = 'us-west-2'

		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.region).toBe('us-west-2')
	})

	it('does not fingerprint IP addresses from context attributes by default', async() => {
		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {
				attributes: {
					ip: '192.168.1.1'
				}
			}
		}

		const attrs = await provider(record)

		expect(attrs.ipHash).toBeUndefined()
	})

	it('does not fingerprint x-forwarded-for by default', async() => {
		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {
				attributes: {
					'x-forwarded-for': '10.0.0.1'
				}
			}
		}

		const attrs = await provider(record)

		expect(attrs.ipHash).toBeUndefined()
	})

	it('should never include raw IP address', async() => {
		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {
				attributes: {
					ip: '192.168.1.1'
				}
			}
		}

		const attrs = await provider(record)

		expect(attrs.ip).toBeUndefined() // Raw IP should never be included
		expect(attrs.ipHash).toBeUndefined()
	})

	it('should use custom getters when provided', async() => {
		const provider = createServerDynamicProvider({
			getRequestId: () => 'custom-request-id',
			getRouteId: () => 'custom-route-id',
			getUserId: () => 'custom-user-id',
			getIpHash: () => 'custom-ip-hash',
			instanceId: 'custom-instance',
			region: 'custom-region'
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const attrs = await provider(record)

		expect(attrs.requestId).toBe('custom-request-id')
		expect(attrs.routeId).toBe('custom-route-id')
		expect(attrs.userId).toBe('custom-user-id')
		expect(attrs.ipHash).toBe('custom-ip-hash')
		expect(attrs.instanceId).toBe('custom-instance')
		expect(attrs.region).toBe('custom-region')
	})

	it('should handle routeId from context attributes', async() => {
		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {
				attributes: {
					routeId: 'test-route'
				}
			}
		}

		const attrs = await provider(record)

		expect(attrs.routeId).toBe('test-route')
	})

	it('should handle non-string IP values gracefully', async() => {
		const provider = createServerDynamicProvider()
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {
				attributes: {
					ip: 12345 as JsonValue // Invalid type (number instead of string)
				}
			}
		}

		const attrs = await provider(record)

		expect(attrs.ipHash).toBeUndefined()
	})
})
