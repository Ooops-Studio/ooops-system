import {describe, expect, it, vi} from 'vitest'

import {
	buildHttpLabels,
	classifyHttpOutcome,
	normalizeHttpMetadata,
	normalizeHttpRoute,
	toPerformanceEventRecord
} from '../../../../src/performance/core/utils/request-helpers'

describe('request helpers', () => {
	it('normalizes routes and metadata', () => {
		expect(normalizeHttpRoute('https://api.example.com/users/123?tab=profile')).toBe('/users/:id')
		expect(normalizeHttpRoute('//api.example.com/users/123')).toBe('/users/:id')
		expect(normalizeHttpRoute('')).toBe('/')
		expect(normalizeHttpRoute('/orders/550e8400-e29b-41d4-a716-446655440000')).toBe('/orders/:id')
		expect(normalizeHttpRoute('users/[userId]#details')).toBe('/users/[userId]')
		expect(normalizeHttpRoute('/tokens/abcdef0123456789')).toBe('/tokens/:id')
		expect(normalizeHttpRoute('/users/alice@example.com')).toBe('/users/:id')
		expect(normalizeHttpRoute('/users/alice%40example.com')).toBe('/users/:id')
		expect(normalizeHttpRoute('/sessions/abcdefghijklmnopqrstuvwxyz012345')).toBe('/sessions/:id')
		expect(normalizeHttpRoute(`/${Array.from({length: 150}, () => 'path').join('/')}`).length).toBeLessThanOrEqual(256)
		expect(normalizeHttpRoute('/users/:userId')).toBe('/users/:userId')

		expect(normalizeHttpMetadata({
			method: 'post',
			route: '/users/123',
			statusCode: 201
		})).toMatchObject({
			method: 'POST',
			route: '/users/:id',
			outcome: 'ok'
		})
		expect(normalizeHttpMetadata({method: ' ', route: '/', statusCode: 999})).toMatchObject({
			method: 'UNKNOWN', route: '/', outcome: 'ok'
		})
		expect(normalizeHttpMetadata({method: ' ', route: '/', statusCode: 999})).not.toHaveProperty('statusCode')
		expect(normalizeHttpMetadata({
			method: 'get', route: '/', statusCode: 100, requestSize: 0, responseSize: 12, outcome: 'timeout'
		})).toMatchObject({statusCode: 100, requestSize: 0, responseSize: 12, outcome: 'timeout'})
		expect(normalizeHttpMetadata({
			method: 'get', route: '/', statusCode: 599, requestSize: -1, responseSize: Number.MAX_SAFE_INTEGER + 1
		})).toMatchObject({statusCode: 599, outcome: 'server_error'})
		expect(normalizeHttpMetadata({method: 'get', route: '/', statusCode: 99})).not.toHaveProperty('statusCode')
		expect(normalizeHttpMetadata({method: 'get', route: '/', statusCode: 600})).not.toHaveProperty('statusCode')
		expect(normalizeHttpMetadata({method: 'get', route: '/', statusCode: 503, outcome: 'invalid' as never})).toMatchObject({outcome: 'server_error'})
		expect(normalizeHttpMetadata({method: 'get', route: '/', statusCode: 503, outcome: 'ok'})).toMatchObject({outcome: 'server_error'})
		expect(normalizeHttpMetadata({method: 'get', route: '/', statusCode: 204, outcome: 'server_error'})).toMatchObject({outcome: 'ok'})
		expect(normalizeHttpMetadata({method: 'get', route: '/', timedOut: true, outcome: 'ok'})).toMatchObject({outcome: 'timeout'})
		expect(normalizeHttpMetadata({method: 'get', route: '/', requestSize: -1})).not.toHaveProperty('requestSize')
		expect(normalizeHttpMetadata({method: 'get', route: '/', responseSize: -1})).not.toHaveProperty('responseSize')
		expect(normalizeHttpMetadata({
			method: 'get', route: '/', aborted: true, timedOut: false, secret: 'drop-me'
		} as never)).toEqual({method: 'GET', route: '/', aborted: true, outcome: 'aborted'})
		expect(() => normalizeHttpMetadata(null as never)).toThrow('metadata')
		expect(() => normalizeHttpMetadata({method: null, route: '/'} as never)).toThrow('method')
		expect(() => normalizeHttpRoute('x'.repeat(2_049))).toThrow('2048')
		expect(normalizeHttpMetadata({
			method: 'bad\nmethod', route: '/', hostKind: 'user@example.com', runtime: 'x'.repeat(80)
		})).toMatchObject({method: 'UNKNOWN', hostKind: '[email]', runtime: '[opaque]'})
		expect(normalizeHttpMetadata({
			method: 'x'.repeat(100_000), route: '/', hostKind: 'x'.repeat(100_000), runtime: 'x'.repeat(100_000)
		})).toEqual({method: 'UNKNOWN', route: '/', outcome: 'ok'})
	})

	it('classifies timeout, abort, client, and server outcomes', () => {
		expect(classifyHttpOutcome({method: 'GET', route: '/', aborted: true})).toBe('aborted')
		expect(classifyHttpOutcome({method: 'GET', route: '/', timedOut: true})).toBe('timeout')
		expect(classifyHttpOutcome({method: 'GET', route: '/', statusCode: 404})).toBe('client_error')
		expect(classifyHttpOutcome({method: 'GET', route: '/', statusCode: 503})).toBe('server_error')
		expect(classifyHttpOutcome({method: 'GET', route: '/', statusCode: 204})).toBe('ok')
		expect(classifyHttpOutcome({method: 'GET', route: '/'})).toBe('ok')
	})

	it('never invokes HTTP metadata accessors', () => {
		const route = vi.fn(() => '/secret')
		const metadata = Object.defineProperties({}, {
			method: {enumerable: true, get: vi.fn(() => 'GET')},
			route: {enumerable: true, get: route}
		})
		expect(() => normalizeHttpMetadata(metadata as never)).toThrow('route')
		expect(route).not.toHaveBeenCalled()
	})

	it('builds labels and event records', () => {
		const labels = buildHttpLabels({
			method: 'GET',
			route: '/health',
			hostKind: 'api',
			runtime: 'server'
		}, {env: 'test'})

		expect(labels).toMatchObject({
			method: 'GET',
			route: '/health',
			status_code: '0',
			status_class: 'unknown',
			host_kind: 'api',
			runtime: 'server',
			env: 'test'
		})
		expect(buildHttpLabels({method: 'post', route: '/users/123', statusCode: 503}, {
			method: 'SPOOFED', route: '/spoofed', status_code: '200', outcome: 'ok'
		})).toMatchObject({
			method: 'POST', route: '/users/:id', status_code: '503', outcome: 'server_error'
		})
		expect(buildHttpLabels({method: 'GET', route: '/', statusCode: 204})).toMatchObject({
			status_class: '2xx', outcome: 'ok'
		})

		const record = toPerformanceEventRecord({
			name: 'http.request',
			duration: 42,
			start: 58,
			end: 100,
			source: 'mark',
			traceId: 'trace-1',
			spanId: 'span-1',
			http: {method: 'GET', route: '/health'},
			dbMetadata: {collection: 'users'}
		})

		expect(record).toMatchObject({
			recordedAt: 100,
			traceId: 'trace-1',
			spanId: 'span-1',
			http: {method: 'GET', route: '/health'},
			dbMetadata: {collection: 'users'}
		})
		expect(toPerformanceEventRecord({
			name: 'plain', duration: 1, start: 1, end: 2, source: 'record'
		})).toEqual({
			recordedAt: 2,
			event: {name: 'plain', duration: 1, start: 1, end: 2, source: 'record'},
			source: 'record'
		})
	})

})
