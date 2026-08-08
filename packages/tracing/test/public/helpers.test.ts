/**
 * @file Tests for public tracing helpers.
 */

import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {SpanStatus} from '@ooopsstudio/core/contracts/tracing'
import type {SpanOptions, Tracing, TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {describe, expect, it, vi} from 'vitest'

import {
	traceDb,
	traceHttpClient,
	traceHttpServer,
	traceJob,
	traceMessageConsume,
	traceMessageProduce,
	traceRpcClient,
	traceRpcServer
} from '../../src/public/helpers'

interface RecordedCall {
	name: string
	options?: SpanOptions
}

function createTracingMock() {

	const recorded: RecordedCall[] = []
	const statuses: SpanStatus[] = []
	const exceptions: unknown[] = []

	const span: TracingSpan = {
		getContext: vi.fn(() => ({
			traceId: '1234567890abcdef1234567890abcdef',
			spanId: '1234567890abcdef'
		})),
		setAttribute: vi.fn(),
		addEvent: vi.fn(),
		recordException: vi.fn((error: unknown) => {
			exceptions.push(error)
		}),
		setStatus: vi.fn((status: SpanStatus) => {
			statuses.push(status)
		}),
		end: vi.fn()
	}

	const tracing = {
		inSpan: vi.fn(async(name: string, fn: (span: TracingSpan) => unknown, options?: SpanOptions) => {
			recorded.push({
				name,
				...(options !== undefined ? {options} : {})
			})
			return await fn(span)
		})
	} as unknown as Tracing

	return {tracing, recorded, statuses, exceptions}
}

function expectAttrs(
	recorded: RecordedCall[],
	expected: LogAttributes,
	kind: SpanOptions['kind']
) {

	expect(recorded).toHaveLength(1)
	expect(recorded[0]?.options?.kind).toBe(kind)
	expect(recorded[0]?.options?.attributes).toEqual(expected)
}

describe('tracing helpers', () => {

	it('should trace HTTP server requests and omit undefined fields', async() => {

		const {tracing, recorded, statuses} = createTracingMock()

		const result = await traceHttpServer(tracing, 'http.server', async() => 'ok', {
			method: 'GET',
			route: '/items',
			attributes: {tenantId: 't1'}
		})

		expect(result).toBe('ok')
		expectAttrs(recorded, {
			'http.method': 'GET',
			'http.route': '/items',
			tenantId: 't1'
		}, 'server')
		expect(statuses).toContainEqual({code: 'ok'})
	})

	it('bounds custom helper attributes without evicting or overriding canonical fields', async() => {
		const {tracing, recorded} = createTracingMock()
		const attributes = Object.fromEntries([
			['http.method', 'SPOOFED'],
			...Array.from({length: 1_000}, (_, index) => [`custom.${index}`, 'x'.repeat(100)])
		])

		await traceHttpServer(tracing, 'http.server', async() => 'ok', {
			method: 'GET', route: '/bounded', attributes
		})

		const captured = recorded[0]?.options?.attributes ?? {}
		expect(captured['http.method']).toBe('GET')
		expect(captured['http.route']).toBe('/bounded')
		expect(Object.keys(captured).length).toBeLessThanOrEqual(128)
		expect(Buffer.byteLength(JSON.stringify(captured))).toBeLessThanOrEqual(8_192)
	})

	it('rejects accessor-backed helper attributes without executing them', async() => {
		let reads = 0
		const options = Object.defineProperties({}, {
			method: {enumerable: true, value: 'GET'},
			attributes: {enumerable: true, get: () => { reads++; return {authorization: 'secret'} }}
		})
		const {tracing} = createTracingMock()
		await expect(traceHttpServer(tracing, 'hostile', async() => undefined, options as never))
			.rejects.toThrow('plain data object')
		expect(reads).toBe(0)
	})

	it('should trace HTTP client requests', async() => {

		const {tracing, recorded} = createTracingMock()

		await traceHttpClient(tracing, 'http.client', async() => 'ok', {
			method: 'POST',
			url: 'https://example.com/items',
			statusCode: 201
		})

		expectAttrs(recorded, {
			'http.method': 'POST',
			'http.url': 'https://example.com/items',
			'http.status_code': 201
		}, 'client')
	})

	it('marks unsuccessful HTTP responses as errors without requiring a thrown value', async() => {
		const server = createTracingMock()
		await traceHttpServer(server.tracing, 'http.server', async() => 'response', {method: 'GET', statusCode: 503})
		expect(server.statuses).toContainEqual({code: 'error', description: 'HTTP 503'})

		const client = createTracingMock()
		await traceHttpClient(client.tracing, 'http.client', async() => 'response', {method: 'GET', statusCode: 404})
		expect(client.statuses).toContainEqual({code: 'error', description: 'HTTP 404'})
	})

	it('should trace database operations', async() => {

		const {tracing, recorded} = createTracingMock()

		await traceDb(tracing, 'db.query', async() => 'ok', {
			system: 'postgresql',
			operation: 'SELECT',
			name: 'selectItems',
			table: 'items'
		})

		expectAttrs(recorded, {
			'db.system': 'postgresql',
			'db.operation': 'SELECT',
			'db.name': 'selectItems',
			'db.sql.table': 'items'
		}, 'client')
	})

	it('should trace produced messages', async() => {

		const {tracing, recorded} = createTracingMock()

		await traceMessageProduce(tracing, 'message.produce', async() => 'ok', {
			system: 'kafka',
			destination: 'orders',
			messageId: 'm1'
		})

		expectAttrs(recorded, {
			'messaging.system': 'kafka',
			'messaging.destination': 'orders',
			'messaging.message.id': 'm1',
			'messaging.operation': 'publish'
		}, 'producer')
	})

	it('should trace consumed messages', async() => {

		const {tracing, recorded} = createTracingMock()

		await traceMessageConsume(tracing, 'message.consume', async() => 'ok', {
			system: 'kafka',
			destination: 'orders',
			consumerId: 'consumer-1',
			messageId: 'm2'
		})

		expectAttrs(recorded, {
			'messaging.system': 'kafka',
			'messaging.destination': 'orders',
			'messaging.consumer.id': 'consumer-1',
			'messaging.message.id': 'm2',
			'messaging.operation': 'process'
		}, 'consumer')
	})

	it('should trace RPC client and server operations', async() => {

		const client = createTracingMock()
		await traceRpcClient(client.tracing, 'rpc.client', async() => 'ok', {
			system: 'grpc',
			service: 'CatalogService',
			method: 'ListItems'
		})
		expectAttrs(client.recorded, {
			'rpc.system': 'grpc',
			'rpc.service': 'CatalogService',
			'rpc.method': 'ListItems'
		}, 'client')

		const server = createTracingMock()
		await traceRpcServer(server.tracing, 'rpc.server', async() => 'ok', {
			system: 'grpc',
			service: 'CatalogService',
			method: 'ListItems'
		})
		expectAttrs(server.recorded, {
			'rpc.system': 'grpc',
			'rpc.service': 'CatalogService',
			'rpc.method': 'ListItems'
		}, 'server')
	})

	it('should trace jobs with internal spans', async() => {

		const {tracing, recorded} = createTracingMock()

		await traceJob(tracing, 'job.run', async() => 'ok', {
			jobType: 'sync',
			jobId: 'job-1'
		})

		expectAttrs(recorded, {
			'job.type': 'sync',
			'job.id': 'job-1'
		}, 'internal')
	})

	it('should propagate the provided parent option', async() => {

		const {tracing, recorded} = createTracingMock()
		const parent = {traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'bbbbbbbbbbbbbbbb'}

		await traceHttpServer(tracing, 'http.server', async() => 'ok', {
			method: 'GET',
			parent
		})

		expect(recorded[0]?.options?.parent).toBe(parent)
	})

	it('should propagate parent options across the remaining helper variants', async() => {

		const parent = {traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'bbbbbbbbbbbbbbbb'}

		const db = createTracingMock()
		await traceDb(db.tracing, 'db.query', async() => 'ok', {
			system: 'postgresql',
			parent
		})
		expect(db.recorded[0]?.options?.parent).toBe(parent)

		const produce = createTracingMock()
		await traceMessageProduce(produce.tracing, 'message.produce', async() => 'ok', {
			system: 'kafka',
			destination: 'orders',
			parent
		})
		expect(produce.recorded[0]?.options?.parent).toBe(parent)

		const consume = createTracingMock()
		await traceMessageConsume(consume.tracing, 'message.consume', async() => 'ok', {
			system: 'kafka',
			destination: 'orders',
			parent
		})
		expect(consume.recorded[0]?.options?.parent).toBe(parent)

		const rpcClient = createTracingMock()
		await traceRpcClient(rpcClient.tracing, 'rpc.client', async() => 'ok', {
			system: 'grpc',
			service: 'CatalogService',
			method: 'ListItems',
			parent
		})
		expect(rpcClient.recorded[0]?.options?.parent).toBe(parent)

		const rpcServer = createTracingMock()
		await traceRpcServer(rpcServer.tracing, 'rpc.server', async() => 'ok', {
			system: 'grpc',
			service: 'CatalogService',
			method: 'ListItems',
			parent
		})
		expect(rpcServer.recorded[0]?.options?.parent).toBe(parent)

		const job = createTracingMock()
		await traceJob(job.tracing, 'job.run', async() => 'ok', {
			jobType: 'sync',
			parent
		})
		expect(job.recorded[0]?.options?.parent).toBe(parent)
	})

	it('should record exceptions and set error status on helper failures', async() => {

		const {tracing, statuses, exceptions} = createTracingMock()
		const error = new Error('boom')

		await expect(
			traceHttpServer(tracing, 'http.server', async() => {
				throw error
			}, {method: 'GET'})
		).rejects.toThrow('boom')

		expect(exceptions).toEqual([error])
		expect(statuses).toContainEqual({code: 'error', description: 'boom'})
	})

	it('does not let hostile span diagnostics replace operation outcomes', async() => {
		let getterCalls = 0
		const makeTracing = (span: Record<string, unknown>) => ({
			inSpan: async(_name: string, callback: (active: unknown) => unknown) => await callback(span)
		}) as never
		const accessorSpan = Object.defineProperties({}, {
			setStatus: {enumerable: true, get: () => { getterCalls++; return vi.fn() }},
			recordException: {enumerable: true, get: () => { getterCalls++; return vi.fn() }}
		})

		await expect(traceHttpServer(makeTracing(accessorSpan), 'safe', async() => 'result', {method: 'GET'}))
			.resolves.toBe('result')
		expect(getterCalls).toBe(0)

		const throwingSpan = {
			setStatus: () => { throw new Error('status failed') },
			recordException: () => { throw new Error('exception failed') }
		}
		const businessError = new Error('business failed')
		await expect(traceHttpServer(makeTracing(throwingSpan), 'safe', async() => { throw businessError }, {method: 'GET'}))
			.rejects.toBe(businessError)

		const rejectingSpan = {
			setStatus: async() => { throw new Error('async status failed') },
			recordException: async() => { throw new Error('async exception failed') }
		}
		await expect(traceHttpServer(makeTracing(rejectingSpan), 'safe', async() => 'result', {method: 'GET'}))
			.resolves.toBe('result')
		await expect(traceHttpServer(makeTracing(rejectingSpan), 'safe', async() => { throw businessError }, {method: 'GET'}))
			.rejects.toBe(businessError)
		await Promise.resolve()
	})

	it('does not assimilate thenables returned by span diagnostics', async() => {
		let thenReads = 0
		const thenable = Object.defineProperty({}, 'then', {
			get: () => { thenReads++; throw new Error('must not execute') }
		})
		const tracing = {
			inSpan: async(_name: string, callback: (active: unknown) => unknown) => await callback({
				setStatus: () => thenable,
				recordException: () => thenable
			})
		} as never
		const businessError = new Error('business')

		await expect(traceHttpServer(tracing, 'safe', async() => 'result', {method: 'GET'})).resolves.toBe('result')
		await expect(traceHttpServer(tracing, 'safe', async() => { throw businessError }, {method: 'GET'})).rejects.toBe(businessError)
		expect(thenReads).toBe(0)
	})
})
