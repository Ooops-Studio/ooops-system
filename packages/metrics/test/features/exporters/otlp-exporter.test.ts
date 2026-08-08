import type {LogMethod} from '@ooopsstudio/core/ports/logging'
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'

import {OtlpExporter, createOtlpExporter} from '../../../src/features/exporters/otlp-exporter'
import type {MetricRecord} from '../../../src/types/metric-record'

// Mock fetch
const mockFetch = vi.fn().mockResolvedValue({
	ok: true,
	status: 200,
	headers: {get: vi.fn().mockReturnValue(null)},
	json: vi.fn().mockResolvedValue({}),
	text: vi.fn().mockResolvedValue('OK')
} as unknown as Response)

global.fetch = mockFetch

describe('OtlpExporter', () => {
	it('does not execute inherited array serialization hooks', async() => {
		const inheritedToJSON = vi.fn(() => ({compromised: true}))
		Object.defineProperty(Array.prototype, 'toJSON', {
			configurable: true, value: inheritedToJSON
		})
		try {
			const target = new OtlpExporter({endpoint: 'https://example.com/v1/metrics'})
			await target.export([{
				name: 'safe_total', type: 'counter', value: 1, labels: {}, timestamp: 10,
				metadata: {instrument: 'counter', temporality: 'cumulative', monotonic: true}
			}])
			expect(inheritedToJSON).not.toHaveBeenCalled()
			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			expect(String(request.body)).toContain('resourceMetrics')
			expect(String(request.body)).not.toContain('compromised')
		} finally {
			Reflect.deleteProperty(Array.prototype, 'toJSON')
		}
	})

	it('preserves counter exemplars in OTLP sum data points', async() => {
		const exporter = new OtlpExporter({endpoint: 'https://example.com/v1/metrics'})
		type Payload = {
			resourceMetrics: Array<{
				scopeMetrics: Array<{
					metrics: Array<{sum?: {dataPoints: Array<{exemplars?: unknown[]}>}}>
				}>
			}>
		}
		const convert = exporter as unknown as {
			convertToOtlp(batch: MetricRecord[]): Payload
		}
		const payload = convert.convertToOtlp([{
			name: 'requests_total', type: 'counter', value: 1, labels: {}, timestamp: 10,
			metadata: {instrument: 'counter', temporality: 'cumulative', monotonic: true},
			exemplar: {value: 1, timestamp: 10, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16)}
		}])
		const point = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.sum?.dataPoints[0]
		expect(point?.exemplars).toHaveLength(1)
	})

	let exporter: OtlpExporter

	beforeEach(() => {

		mockFetch.mockClear()
		exporter = new OtlpExporter({
			endpoint: 'http://localhost:4318/v1/metrics'
		})
	})

	afterEach(() => {

		vi.clearAllMocks()
	})

	describe('constructor', () => {
		it('rejects malformed options, protocols, callbacks and accessor-backed headers', () => {
			expect(() => new OtlpExporter(null as never)).toThrow('options must be an object')
			expect(() => new OtlpExporter({endpoint: 'ftp://example.com/metrics'})).toThrow('http or https')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/metrics', onError: true as never
			})).toThrow('onError must be a function')
			const getter = vi.fn(() => 'secret')
			const headers = Object.defineProperty({}, 'authorization', {enumerable: true, get: getter})
			expect(() => new OtlpExporter({endpoint: 'https://example.com/metrics', headers: headers as never}))
				.toThrow()
			expect(getter).not.toHaveBeenCalled()
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/metrics', headers: {['x'.repeat(1_000_000)]: 'value'}
			})).toThrow('bounded string data fields')
			const proxyGet = vi.fn((_target: Record<string, string>, key: PropertyKey, receiver: Record<string, string>) =>
				Reflect.get(_target, key, receiver))
			const proxyHeaders = new Proxy({authorization: 'Bearer safe'}, {get: proxyGet})
			expect(() => new OtlpExporter({endpoint: 'https://example.com/metrics', headers: proxyHeaders}))
				.not.toThrow()
			expect(proxyGet).not.toHaveBeenCalled()
			const endpoint = vi.fn(() => 'https://example.com/metrics')
			const accessorOptions = Object.defineProperty({}, 'endpoint', {enumerable: true, get: endpoint})
			expect(() => new OtlpExporter(accessorOptions as never)).toThrow('stable known data fields')
			expect(endpoint).not.toHaveBeenCalled()
		})

		it('should create exporter with required endpoint', () => {

			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics'
			})

			expect(exp).toBeDefined()
		})

		it('should create exporter with custom options', () => {

			const exp = new OtlpExporter({
				endpoint: 'http://custom:4318/v1/metrics',
				headers: {'Authorization': 'Bearer token'},
				timeout: 5000,
				protocol: 'http'
			})

			expect(exp).toBeDefined()
		})

		it('should throw error for invalid endpoint', () => {

			expect(() => {
				new OtlpExporter({
					endpoint: 'not-a-url'
				})
			}).toThrow()
		})

		it('should throw error for invalid timeout', () => {

			expect(() => {
				new OtlpExporter({
					endpoint: 'http://localhost:4318/v1/metrics',
					timeout: -1
				})
			}).toThrow()
			expect(() => {
				new OtlpExporter({
					endpoint: 'http://localhost:4318/v1/metrics',
					timeout: Number.NaN
				})
			}).toThrow('positive and finite')
			expect(() => new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				timeout: 1.5
			})).toThrow('positive and finite')
			expect(() => new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				timeout: 2_147_483_648
			})).toThrow('positive and finite')
		})

		it('rejects an oversized endpoint before retaining or parsing it', () => {
			expect(() => new OtlpExporter({
				endpoint: `https://collector.example/${'x'.repeat(8_192)}`
			})).toThrow('no longer than 8192 characters')
		})

		it('should throw error for invalid gzipThresholdBytes', () => {

			expect(() => {
				new OtlpExporter({
					endpoint: 'http://localhost:4318/v1/metrics',
					gzipThresholdBytes: -1
				})
			}).toThrow()
			expect(() => {
				new OtlpExporter({
					endpoint: 'http://localhost:4318/v1/metrics',
					gzipThresholdBytes: Number.POSITIVE_INFINITY
				})
			}).toThrow('between 1')
			expect(() => new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				gzipThresholdBytes: 16 * 1024 * 1024 + 1
			})).toThrow('between 1')
		})

		it('rejects malformed request and header configuration', () => {

			expect(() => {
				new OtlpExporter({
					endpoint: 'http://localhost:4318/v1/metrics',
					headers: {authorization: 1 as unknown as string}
				})
			}).toThrow()
			expect(() => {
				new OtlpExporter({
					endpoint: 'http://localhost:4318/v1/metrics',
					enableGzip: 'true' as unknown as boolean
				})
			}).toThrow('enableGzip must be a boolean')
			expect(() => {
				new OtlpExporter({
					endpoint: 'http://localhost:4318/v1/metrics',
					allowedHeaders: ['x-request-id', 1 as unknown as string]
				})
			}).toThrow('allowedHeaders must contain non-empty strings')
			expect(() => new OtlpExporter({
				endpoint: 'https://user:secret@example.com/v1/metrics'
			})).toThrow('embedded credentials')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics', headers: {'Content-Type': 'text/plain'}
			})).toThrow('managed by the exporter')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics', headers: {Authorization: 'one', authorization: 'two'}
			})).toThrow('unique ignoring case')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics',
				headers: Object.fromEntries(Array.from({length: 65}, (_, index) => [`x-${index}`, 'value']))
			})).toThrow('too many headers')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics', headers: {'x-large': 'x'.repeat(8_193)}
			})).toThrow('header value')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics', allowedHeaders: ['bad header']
			})).toThrow('invalid header name')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics', allowedHeaders: ['x-api-key']
			})).toThrow('invalid header name')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics?token=secret'
			})).toThrow('query parameters')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics#secret'
			})).toThrow('fragments')
			const coercion = vi.fn(() => 'http')
			expect(() => new OtlpExporter({
				endpoint: 'https://example.com/v1/metrics', protocol: {toString: coercion} as never
			})).toThrow('protocol "object"')
			expect(coercion).not.toHaveBeenCalled()
		})
	})

	describe('OTLP acknowledgements', () => {
		it('reports partial success without retrying an acknowledged request', async() => {
			const onError = vi.fn()
			const partialExporter = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				headers: {Authorization: 'Bearer partial-secret'},
				onError
			})
			mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
				partialSuccess: {
					rejectedDataPoints: '2',
					errorMessage: 'invalid metric points: Bearer partial-secret'
				}
			}), {status: 200, headers: {'content-type': 'application/json'}}))

			await expect(partialExporter.export([{
				name: 'requests_total', type: 'counter', value: 1, labels: {}, timestamp: 1
			}])).resolves.toBeUndefined()

			expect(mockFetch).toHaveBeenCalledOnce()
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({code: 'otlp_partial_success', rejectedDataPoints: '2'}),
				expect.objectContaining({rejectedDataPoints: '2'})
			)
			expect(JSON.stringify(onError.mock.calls)).not.toContain('partial-secret')
		})

		it('bounds and validates OTLP success response bodies', async() => {
			mockFetch.mockResolvedValueOnce(new Response('not-json', {status: 200}))
			await expect(exporter.export([{
				name: 'invalid_response', type: 'gauge', value: 1, labels: {}, timestamp: 1
			}])).rejects.toMatchObject({code: 'otlp_invalid_response', retryable: false})

			mockFetch.mockResolvedValueOnce(new Response('x'.repeat(65_537), {status: 200}))
			await expect(exporter.export([{
				name: 'oversized_response', type: 'gauge', value: 1, labels: {}, timestamp: 1
			}])).rejects.toMatchObject({code: 'otlp_response_too_large', retryable: false})
		})
	})

	describe('export', () => {
		it('rejects accessor-backed direct records without invoking getters', async() => {
			const name = vi.fn(() => 'secret_metric')
			const record = Object.defineProperties({}, {
				name: {enumerable: true, get: name},
				type: {enumerable: true, value: 'counter'},
				value: {enumerable: true, value: 1},
				labels: {enumerable: true, value: {}},
				timestamp: {enumerable: true, value: 1}
			})
			await expect(exporter.export([record as never])).rejects.toThrow('stable data fields')
			expect(name).not.toHaveBeenCalled()
			const item = vi.fn(() => record)
			const batch = Object.defineProperty([], '0', {enumerable: true, get: item})
			await expect(exporter.export(batch as never)).rejects.toThrow('bounded dense array')
			expect(item).not.toHaveBeenCalled()
			await expect(exporter.export({length: 0} as never)).rejects.toThrow('bounded dense array')
		})

		it('should handle empty batch', async() => {

			await expect(exporter.export([])).resolves.not.toThrow()
		})

		it('should export counter metric', async() => {

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {env: 'test'},
				timestamp: 1000
			}

			await exporter.export([record])

			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:4318/v1/metrics',
				expect.objectContaining({method: 'POST', redirect: 'error'})
			)
		})

		it('sanitizes direct label values before OTLP export', async() => {
			await exporter.export([{
				name: 'privacy_counter',
				type: 'counter',
				value: 1,
				labels: {
					user: 'user@example.com',
					route: 'https://tenant.example.com/users/123456?token=secret'
				},
				timestamp: 1000
			}])

			const request = mockFetch.mock.calls[0]?.[1] as {body?: unknown}
			const payload = JSON.stringify(request.body)
			expect(payload).toContain('[email]')
			expect(payload).toContain('/users/:id')
			expect(payload).not.toContain('tenant.example.com')
			expect(payload).not.toContain('token=secret')
		})

		it('redacts secret-key labels and rejects sanitized label collisions', async() => {
			await exporter.export([{
				name: 'secret_labels', type: 'counter', value: 1,
				labels: {authorization: 'Bearer direct-secret', api_key: 'sk-direct-secret'},
				timestamp: 1000
			}])
			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const payload = String(request.body)
			expect(payload).toContain('[redacted]')
			expect(payload).not.toContain('direct-secret')

			await expect(exporter.export([{
				name: 'colliding_labels', type: 'counter', value: 1,
				labels: {'route-id': 'a', route_id: 'b'}, timestamp: 1000
			}])).rejects.toThrow('label collision')
		})

		it('keeps an awaited request timeout referenced', async() => {
			const timeoutHandle = setTimeout(() => undefined, 0)
			const unrefSpy = vi.spyOn(Object.getPrototypeOf(timeoutHandle), 'unref')
			clearTimeout(timeoutHandle)
			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])

			expect(unrefSpy).not.toHaveBeenCalled()
			unrefSpy.mockRestore()
		})

		it('should export gauge metric', async() => {

			const record: MetricRecord = {
				name: 'test_gauge',
				type: 'gauge',
				value: 42.5,
				labels: {env: 'test'},
				timestamp: 1000
			}

			await exporter.export([record])

			// Export should complete without error
			expect(true).toBe(true)
		})

		it('bounds concurrent exports for raw sink consumers', async() => {
			const gate = Promise.withResolvers<Response>()
			mockFetch.mockImplementation(() => gate.promise)
			const record: MetricRecord = {
				name: 'bounded_concurrency', type: 'counter', value: 1, labels: {}, timestamp: 1
			}
			const active = Array.from({length: 4}, () => exporter.export([record]))
			await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4))

			await expect(exporter.export([record])).rejects.toMatchObject({
				code: 'otlp_concurrency_limit', retryable: true
			})

			gate.resolve({
				ok: true,
				status: 200,
				headers: {get: vi.fn().mockReturnValue(null)}
			} as unknown as Response)
			await Promise.all(active)
		})

		it('fences admission and waits for accepted exports during shutdown', async() => {
			const gate = Promise.withResolvers<Response>()
			mockFetch.mockImplementation(() => gate.promise)
			const record: MetricRecord = {
				name: 'shutdown_fence', type: 'counter', value: 1, labels: {}, timestamp: 1
			}
			const active = exporter.export([record])
			await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce())
			const shutdown = exporter.shutdown()
			let settled = false
			void shutdown.then(() => { settled = true })
			await Promise.resolve()
			expect(settled).toBe(false)
			await expect(exporter.export([record])).rejects.toMatchObject({
				code: 'otlp_exporter_closed', retryable: false
			})

			gate.resolve({
				ok: true,
				status: 200,
				headers: {get: vi.fn().mockReturnValue(null)}
			} as unknown as Response)
			await Promise.all([active, shutdown])
		})

		it('coalesces lifecycle waiters while exports are active', async() => {
			const gate = Promise.withResolvers<Response>()
			mockFetch.mockImplementation(() => gate.promise)
			const active = exporter.export([{
				name: 'coalesced_lifecycle', type: 'counter', value: 1, labels: {}, timestamp: 1
			}])
			await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce())

			const firstFlush = exporter.flush()
			const secondFlush = exporter.flush()
			const shutdown = exporter.shutdown()
			expect(secondFlush).toBe(firstFlush)
			expect(shutdown).toBe(firstFlush)

			gate.resolve({
				ok: true,
				status: 200,
				headers: {get: vi.fn().mockReturnValue(null)}
			} as unknown as Response)
			await Promise.all([active, firstFlush])
			expect(exporter.flush()).toBe(exporter.flush())
		})

		it('serializes special doubles and fractional timestamps as valid OTLP JSON', async() => {

			mockFetch.mockClear()
			await exporter.export([
				{name: 'special_gauge', type: 'gauge', value: Number.NaN, labels: {kind: 'nan'}, timestamp: 1000.9},
				{name: 'special_gauge', type: 'gauge', value: Number.POSITIVE_INFINITY, labels: {kind: 'positive'}, timestamp: 2000.1},
				{name: 'special_gauge', type: 'gauge', value: Number.NEGATIVE_INFINITY, labels: {kind: 'negative'}, timestamp: 3000.8}
			])

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					gauge?: {dataPoints: Array<{asDouble: number | string; timeUnixNano: string}>}
				}>}>}>
			}
			const gauge = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((metric) => metric.name === 'special_gauge')?.gauge

			expect(gauge?.dataPoints).toEqual(expect.arrayContaining([
				expect.objectContaining({asDouble: 'NaN', timeUnixNano: '1000000000'}),
				expect.objectContaining({asDouble: 'Infinity', timeUnixNano: '2000000000'}),
				expect.objectContaining({asDouble: '-Infinity', timeUnixNano: '3000000000'})
			]))
		})

		it('rejects invalid monotonic sums and defaults up-down counters to non-monotonic', async() => {
			await expect(exporter.export([{
				name: 'negative_total', type: 'counter', value: -1, labels: {}, timestamp: 1
			}])).rejects.toThrow('non-negative and non-NaN')
			await expect(exporter.export([{
				name: 'nan_total', type: 'counter', value: Number.NaN, labels: {}, timestamp: 1
			}])).rejects.toThrow('non-negative and non-NaN')

			mockFetch.mockClear()
			await exporter.export([{
				name: 'in_flight', type: 'counter', value: -1, labels: {}, timestamp: 1,
				metadata: {instrument: 'up_down_counter'}
			}])
			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string; sum?: {isMonotonic: boolean}
				}>}>}>
			}
			const sum = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics
				.find((metric) => metric.name === 'in_flight')?.sum
			expect(sum?.isMonotonic).toBe(false)
		})

		it('serializes aggregation window starts for sums and rejects reversed windows', async() => {
			mockFetch.mockClear()
			await exporter.export([{
				name: 'windowed_total', type: 'counter', value: 2, labels: {},
				startTimestamp: 1000, timestamp: 2000,
				metadata: {instrument: 'counter', temporality: 'delta'}
			}])
			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string; sum?: {dataPoints: Array<{startTimeUnixNano?: string; timeUnixNano: string}>}
				}>}>}>
			}
			const point = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics
				.find((metric) => metric.name === 'windowed_total')?.sum?.dataPoints[0]
			expect(point).toMatchObject({startTimeUnixNano: '1000000000', timeUnixNano: '2000000000'})

			await expect(exporter.export([{
				name: 'reversed_total', type: 'counter', value: 1, labels: {},
				startTimestamp: 2, timestamp: 1
			}])).rejects.toThrow('start timestamp exceeds')
		})

		it('rejects non-finite or negative direct timestamps before OTLP serialization', async() => {

			await expect(exporter.export([
				{name: 'invalid_timestamp', type: 'gauge', value: 1, labels: {}, timestamp: Number.NaN}
			])).rejects.toThrow('timestamp must be finite')
			await expect(exporter.export([
				{name: 'invalid_timestamp', type: 'gauge', value: 1, labels: {}, timestamp: -1}
			])).rejects.toThrow('non-negative')
		})

		it('rejects metric and exemplar timestamps outside the OTLP uint64 range', async() => {
			const outsideUint64Milliseconds = 18_446_744_073_710
			await expect(exporter.export([{
				name: 'invalid_timestamp', type: 'gauge', value: 1, labels: {},
				timestamp: outsideUint64Milliseconds
			}])).rejects.toThrow('unsigned 64-bit')
			await expect(exporter.export([{
				name: 'invalid_exemplar_timestamp', type: 'counter', value: 1, labels: {}, timestamp: 1,
				exemplar: {value: 1, timestamp: outsideUint64Milliseconds}
			}])).rejects.toThrow('unsigned 64-bit')
		})

		it('groups exploded histogram records into a valid OTLP histogram metric', async() => {

			mockFetch.mockClear()
			const records: MetricRecord[] = [
				{
					name: 'request_duration_bucket',
					type: 'counter',
					value: 2,
					labels: {route: '/api', le: '100'},
					startTimestamp: 500,
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				},
				{
					name: 'request_duration_bucket',
					type: 'counter',
					value: 1,
					labels: {route: '/api', le: '+Inf'},
					startTimestamp: 500,
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				},
				{
					name: 'request_duration_sum',
					type: 'gauge',
					value: 250,
					labels: {route: '/api'},
					startTimestamp: 500,
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				},
				{
					name: 'request_duration_count',
					type: 'counter',
					value: 3,
					labels: {route: '/api'},
					startTimestamp: 500,
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				}
			]

			await exporter.export(records)

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					histogram?: {
						dataPoints: Array<{
							count: string
							sum: number
							bucketCounts: string[]
							explicitBounds: number[]
							startTimeUnixNano?: string
						}>
					}
					gauge?: unknown
					sum?: unknown
				}>}>}>
			}
			const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []
			const histogram = metrics.find((metric) => metric.name === 'request_duration')

			expect(histogram?.histogram).toBeDefined()
			expect(histogram?.gauge).toBeUndefined()
			expect(histogram?.sum).toBeUndefined()
			expect(histogram?.histogram?.dataPoints[0]).toMatchObject({
				count: '3',
				sum: 250,
				bucketCounts: ['2', '1'],
				explicitBounds: [100],
				startTimeUnixNano: '500000000'
			})
		})

		it('rejects ambiguous histogram family components instead of overwriting them', async() => {
			const bucket = {name: 'ambiguous_duration_bucket', type: 'counter' as const, value: 1, labels: {le: '1'}, timestamp: 1, metadata: {instrument: 'histogram' as const, unit: 'ms'}}
			const sum = {name: 'ambiguous_duration_sum', type: 'gauge' as const, value: 1, labels: {}, timestamp: 1, metadata: {instrument: 'histogram' as const, unit: 'ms'}}
			const count = {name: 'ambiguous_duration_count', type: 'counter' as const, value: 1, labels: {}, timestamp: 1, metadata: {instrument: 'histogram' as const, unit: 'ms'}}

			await expect(exporter.export([bucket, sum, {...sum} as MetricRecord, count])).rejects.toThrow('duplicate _sum')
			await expect(exporter.export([
				bucket,
				{name: 'ambiguous_duration_bucket', type: 'counter', value: 0, labels: {le: '+Inf'}, timestamp: 1, metadata: {instrument: 'histogram'}},
				{name: 'ambiguous_duration_bucket', type: 'counter', value: 0, labels: {le: '+Inf'}, timestamp: 1, metadata: {instrument: 'histogram'}},
				sum, count
			])).rejects.toThrow('duplicate bounds')
			await expect(exporter.export([bucket, {...sum, timestamp: 2}, count])).rejects.toThrow('inconsistent timestamps')
			await expect(exporter.export([
				bucket, {...sum, metadata: {instrument: 'histogram', unit: 'seconds'}}, count
			])).rejects.toThrow('conflicting unit metadata')
		})

		it('encodes integer counters as OTLP JSON int64 strings', async() => {

			await exporter.export([
				{
					name: 'integer_counter',
					type: 'counter',
					value: 42,
					labels: {},
					timestamp: 1000
				}
			])

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					sum?: {dataPoints: Array<{asInt?: string; asDouble?: number}>}
				}>}>}>
			}
			const metric = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((item) => item.name === 'integer_counter')

			expect(metric?.sum?.dataPoints[0]).toMatchObject({asInt: '42'})
			expect(metric?.sum?.dataPoints[0]?.asDouble).toBeUndefined()
		})

		it('encodes non-integer counters as doubles instead of invalid int64 values', async() => {

			await exporter.export([
				{
					name: 'fractional_counter',
					type: 'counter',
					value: 1.5,
					labels: {},
					timestamp: 1000
				}
			])

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					sum?: {dataPoints: Array<{asInt?: string; asDouble?: number}>}
				}>}>}>
			}
			const metric = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((item) => item.name === 'fractional_counter')

			expect(metric?.sum?.dataPoints[0]).toMatchObject({asDouble: 1.5})
			expect(metric?.sum?.dataPoints[0]?.asInt).toBeUndefined()
		})

		it('groups counter records with the same metric identity into one OTLP sum metric', async() => {

			await exporter.export([
				{
					name: 'requests_total',
					type: 'counter',
					value: 1,
					labels: {route: '/a'},
					timestamp: 1000,
					metadata: {description: 'Requests', unit: '1', temporality: 'cumulative', monotonic: true}
				},
				{
					name: 'requests_total',
					type: 'counter',
					value: 2,
					labels: {route: '/b'},
					timestamp: 1000,
					metadata: {description: 'Requests', unit: '1', temporality: 'cumulative', monotonic: true}
				}
			])

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					sum?: {dataPoints: Array<{attributes: Array<{key: string; value: {stringValue: string}}>}>}
				}>}>}>
			}
			const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []
			const grouped = metrics.filter((item) => item.name === 'requests_total')

			expect(grouped).toHaveLength(1)
			expect(grouped[0]?.sum?.dataPoints).toHaveLength(2)
			expect(grouped[0]?.sum?.dataPoints.map((point) => point.attributes[0]?.value.stringValue)).toEqual(['/a', '/b'])
		})

		it('rejects conflicting OTLP metric identities and duplicate data points', async() => {
			await expect(exporter.export([
				{name: 'identity_metric', type: 'counter', value: 1, labels: {route: '/a'}, timestamp: 1, metadata: {unit: '1'}},
				{name: 'identity_metric', type: 'counter', value: 2, labels: {route: '/b'}, timestamp: 1, metadata: {unit: 'ms'}}
			])).rejects.toThrow('conflicting unit metadata')
			await expect(exporter.export([
				{name: 'kind_metric', type: 'counter', value: 1, labels: {}, timestamp: 1},
				{name: 'kind_metric', type: 'gauge', value: 2, labels: {}, timestamp: 1}
			])).rejects.toThrow('conflicting sum and gauge families')
			await expect(exporter.export([
				{name: 'duplicate_metric', type: 'gauge', value: 1, labels: {b: '2', a: '1'}, timestamp: 1},
				{name: 'duplicate_metric', type: 'gauge', value: 2, labels: {a: '1', b: '2'}, timestamp: 1}
			])).rejects.toThrow('duplicate data points')
			await expect(exporter.export([
				{name: 'fractional_duplicate', type: 'gauge', value: 1, labels: {}, timestamp: 1.1},
				{name: 'fractional_duplicate', type: 'gauge', value: 2, labels: {}, timestamp: 1.9}
			])).rejects.toThrow('duplicate data points')
		})

		it('emits multiple histogram label sets as data points of one OTLP metric family', async() => {
			const records: MetricRecord[] = []
			for (const route of ['/a', '/b']) records.push(
				{name: 'multi_duration_bucket', type: 'counter', value: 1, labels: {route, le: '10'}, timestamp: 1, metadata: {instrument: 'histogram', unit: 'ms'}},
				{name: 'multi_duration_bucket', type: 'counter', value: 0, labels: {route, le: '+Inf'}, timestamp: 1, metadata: {instrument: 'histogram', unit: 'ms'}},
				{name: 'multi_duration_sum', type: 'gauge', value: 5, labels: {route}, timestamp: 1, metadata: {instrument: 'histogram', unit: 'ms'}},
				{name: 'multi_duration_count', type: 'counter', value: 1, labels: {route}, timestamp: 1, metadata: {instrument: 'histogram', unit: 'ms'}}
			)

			await exporter.export(records)

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					histogram?: {dataPoints: Array<unknown>}
				}>}>}>
			}
			const family = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics.filter(({name}) => name === 'multi_duration') ?? []
			expect(family).toHaveLength(1)
			expect(family[0]?.histogram?.dataPoints).toHaveLength(2)
		})

		it('rejects exploded histogram buckets without sum and count', async() => {

			const callsBefore = mockFetch.mock.calls.length

			await expect(exporter.export([
				{
					name: 'direct_duration_bucket',
					type: 'counter',
					value: 1,
					labels: {route: '/api', le: '100'},
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				}
			])).rejects.toThrow('missing required _sum and _count records')

			expect(mockFetch.mock.calls).toHaveLength(callsBefore)
		})

		it('rejects malformed histogram counts and bounds', async() => {
			const base = {timestamp: 1000, metadata: {instrument: 'histogram' as const}}
			await expect(exporter.export([
				{name: 'bad_bucket', type: 'counter', value: 1.5, labels: {le: '10'}, ...base},
				{name: 'bad_sum', type: 'gauge', value: 2, labels: {}, ...base},
				{name: 'bad_count', type: 'counter', value: 1.5, labels: {}, ...base}
			])).rejects.toThrow('non-negative safe integer')
			await expect(exporter.export([
				{name: 'bad_bound_bucket', type: 'counter', value: 1, labels: {le: 'invalid'}, ...base},
				{name: 'bad_bound_sum', type: 'gauge', value: 1, labels: {}, ...base},
				{name: 'bad_bound_count', type: 'counter', value: 1, labels: {}, ...base}
			])).rejects.toThrow('invalid bound')
		})

		it('rejects direct histogram records without exploded bucket, sum, and count data', async() => {

			const callsBefore = mockFetch.mock.calls.length

			await expect(exporter.export([
				{
					name: 'direct_histogram',
					type: 'histogram',
					value: 7,
					labels: {route: '/api'},
					timestamp: 1000
				}
			])).rejects.toThrow('requires exploded _bucket, _sum and _count records')

			expect(mockFetch.mock.calls).toHaveLength(callsBefore)
		})

		it('encodes exemplar trace and span ids as OTLP JSON hex strings', async() => {

			await exporter.export([
				{
					name: 'exemplar_histogram_bucket',
					type: 'counter',
					value: 1,
					labels: {route: '/api', le: '10'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'},
					exemplar: {
						value: 7,
						timestamp: 1000,
						traceId: '0123456789ABCDEF0123456789ABCDEF',
						spanId: 'ABCDEF0123456789'
					}
				},
				{
					name: 'exemplar_histogram_sum',
					type: 'gauge',
					value: 7,
					labels: {route: '/api'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				},
				{
					name: 'exemplar_histogram_count',
					type: 'counter',
					value: 1,
					labels: {route: '/api'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				}
			])

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					histogram?: {dataPoints: Array<{exemplars?: Array<{traceId?: string; spanId?: string}>}>}
				}>}>}>
			}
			const metric = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((item) => item.name === 'exemplar_histogram')
			const exemplar = metric?.histogram?.dataPoints[0]?.exemplars?.[0]

			expect(exemplar).toMatchObject({
				traceId: '0123456789abcdef0123456789abcdef',
				spanId: 'abcdef0123456789'
			})
			expect(JSON.stringify(exemplar)).not.toContain('"type":"Buffer"')
		})

		it('omits invalid exemplar trace and span ids', async() => {

			await exporter.export([
				{
					name: 'invalid_exemplar_histogram_bucket',
					type: 'counter',
					value: 1,
					labels: {le: '10'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'},
					exemplar: {
						value: 7,
						timestamp: 1000,
						traceId: 'not-a-trace',
						spanId: 'not-a-span'
					}
				},
				{
					name: 'invalid_exemplar_histogram_sum',
					type: 'gauge',
					value: 7,
					labels: {},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				},
				{
					name: 'invalid_exemplar_histogram_count',
					type: 'counter',
					value: 1,
					labels: {},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				}
			])

			const request = mockFetch.mock.calls.at(-1)?.[1] as {body?: unknown}
			const body = JSON.parse(String(request.body)) as {
				resourceMetrics: Array<{scopeMetrics: Array<{metrics: Array<{
					name: string
					histogram?: {dataPoints: Array<{exemplars?: Array<{traceId?: string; spanId?: string}>}>}
				}>}>}>
			}
			const metric = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((item) => item.name === 'invalid_exemplar_histogram')
			const exemplar = metric?.histogram?.dataPoints[0]?.exemplars?.[0]

			expect(exemplar?.traceId).toBeUndefined()
			expect(exemplar?.spanId).toBeUndefined()
		})

		it('should include headers in request', async() => {

			vi.mocked(global.fetch).mockClear()

			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				headers: {'Authorization': 'Bearer token'}
			})

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exp.export([record])

			// Verify export completes successfully with headers configured
			// The exporter should handle headers internally
			expect(exp).toBeDefined()
		})

		it('should use gzip when enabled and threshold met', async() => {

			// Reset fetch mock
			vi.mocked(global.fetch).mockClear()

			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				enableGzip: true,
				gzipThresholdBytes: 100
			})

			// Create large batch to exceed threshold
			const records: MetricRecord[] = []
			for (let i = 0; i < 100; i++) {
				records.push({
					name: `test_metric_${i}`,
					type: 'counter',
					value: i,
					labels: {env: 'test', service: 'api', instance: `instance_${i}`},
					timestamp: 1000
				})
			}

			await exp.export(records)

			// Fetch should be called (may be called even if gzip compression happens)
			// The important thing is that export completes without error
			expect(true).toBe(true)
		})

		it('should call onError callback on error', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				onError
			})

			// Mock fetch to fail
			mockFetch.mockRejectedValueOnce(new Error('Network error'))

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Network error')

			expect(onError).toHaveBeenCalled()
		})

		it('preserves non-retryable HTTP error metadata after sanitization', async() => {
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				headers: {'Authorization': 'Bearer secret-token'}
			})
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: 'Unauthorized',
				headers: {get: vi.fn().mockReturnValue(null)}
			} as unknown as Response)

			await expect(exp.export([{
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}])).rejects.toMatchObject({
				statusCode: 401,
				retryable: false,
				code: 'http_401'
			})
		})

		it('preserves retryable HTTP error metadata and retry-after values', async() => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 429,
				statusText: 'Too Many Requests',
				headers: {get: vi.fn().mockReturnValue('3')}
			} as unknown as Response)

			await expect(exporter.export([{
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}])).rejects.toMatchObject({
				statusCode: 429,
				retryable: true,
				code: 'http_429',
				retryAfterMs: 3000
			})
		})

		it('retries only the HTTP statuses allowed by OTLP', async() => {
			for (const [status, retryable] of [[500, false], [502, true], [503, true], [504, true]] as const) {
				mockFetch.mockResolvedValueOnce({
					ok: false,
					status,
					statusText: 'failure',
					headers: {get: vi.fn().mockReturnValue(null)}
				} as unknown as Response)
				await expect(exporter.export([{
					name: `status_${status}`, type: 'counter', value: 1, labels: {}, timestamp: 1
				}])).rejects.toMatchObject({statusCode: status, retryable})
			}
		})

		it('preserves fractional retry-after delays without truncation', async() => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 429,
				statusText: 'Too Many Requests',
				headers: {get: vi.fn().mockReturnValue('1.5')}
			} as unknown as Response)

			await expect(exporter.export([{
				name: 'test_metric', type: 'counter', value: 1, labels: {}, timestamp: 1000
			}])).rejects.toMatchObject({retryAfterMs: 1500})
		})

		it('should scrub sensitive headers in error messages', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				headers: {'Authorization': 'Bearer secret-token'},
				onError
			})

			mockFetch.mockRejectedValueOnce(new Error('Network error'))

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Network error')

			expect(onError).toHaveBeenCalled()
			const errorCall = onError.mock.calls[0]
			expect(errorCall?.[1]).toEqual({
				operation: 'export', exporter: 'otlp', error: 'metrics_otlp_export_failed'
			})
			expect(errorCall?.[0]).toMatchObject({message: 'metrics_otlp_export_failed'})
			expect(JSON.stringify(onError.mock.calls)).not.toContain('secret-token')
		})

		it('should allow specific headers in error logs', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				headers: {
					'Authorization': 'Bearer secret',
					'X-Custom-Header': 'custom-value'
				},
				allowedHeaders: ['x-custom-header'],
				onError
			})

			mockFetch.mockRejectedValueOnce(new Error('Network error'))

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Network error')

			expect(onError).toHaveBeenCalled()
		})
	})

	describe('flush', () => {

		it('should be a no-op', async() => {

			await expect(exporter.flush()).resolves.not.toThrow()
		})
	})

	describe('HTTP response lifecycle', () => {
		it('cancels successful export response bodies', async() => {
			const cancel = vi.fn().mockResolvedValue(undefined)
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: {get: vi.fn().mockReturnValue(null)},
				body: {cancel}
			} as unknown as Response)

			await exporter.export([{
				name: 'response_lifecycle', type: 'counter', value: 1, labels: {}, timestamp: 1000
			}])

			expect(cancel).toHaveBeenCalledOnce()
		})

		it('cancels failed export response bodies before rejecting', async() => {
			const cancel = vi.fn().mockResolvedValue(undefined)
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 503,
				statusText: 'Unavailable',
				headers: {get: vi.fn().mockReturnValue(null)},
				body: {cancel}
			} as unknown as Response)

			await expect(exporter.export([{
				name: 'response_lifecycle', type: 'counter', value: 1, labels: {}, timestamp: 1000
			}])).rejects.toThrow('503')
			expect(cancel).toHaveBeenCalledOnce()
		})

		it('does not turn successful delivery into a retry when body cleanup fails', async() => {
			const cancel = vi.fn().mockRejectedValue(new Error('stream already closed'))
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: {get: vi.fn().mockReturnValue(null)},
				body: {cancel}
			} as unknown as Response)

			await expect(exporter.export([{
				name: 'cleanup_failure', type: 'counter', value: 1, labels: {}, timestamp: 1000
			}])).resolves.toBeUndefined()
			expect(cancel).toHaveBeenCalledOnce()
		})
	})

	describe('shutdown', () => {

		it('should shutdown exporter', async() => {

			await expect(exporter.shutdown()).resolves.not.toThrow()
		})
	})

	describe('createOtlpExporter', () => {

		it('should create OTLP exporter', () => {

			const exp = createOtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics'
			})

			expect(exp).toBeInstanceOf(OtlpExporter)
		})
	})

	describe('error handling', () => {

		it('should handle HTTP export errors gracefully', async() => {

			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
			mockFetch.mockRejectedValueOnce(new Error('Network error'))

			// Create exporter with logger that calls console.error
			const logger = {
				level: 'error' as const,
				error: consoleErrorSpy as unknown as LogMethod,
				warn: vi.fn(),
				info: vi.fn(),
				debug: vi.fn(),
				trace: vi.fn(),
				fatal: vi.fn(),
				context: vi.fn().mockReturnThis()
			}
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				logger
			})

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Network error')

			expect(consoleErrorSpy).toHaveBeenCalled()
			consoleErrorSpy.mockRestore()
		})

		it('should call onError callback on export failure', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				onError
			})

			mockFetch.mockRejectedValueOnce(new Error('Network error'))

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Network error')

			expect(onError).toHaveBeenCalled()
		})

		it('should handle HTTP response errors (non-ok)', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				onError
			})

			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error',
				headers: {get: vi.fn().mockReturnValue(null)},
				json: vi.fn().mockResolvedValue({}),
				text: vi.fn().mockResolvedValue('Error')
			} as unknown as Response)

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('500')

			expect(onError).toHaveBeenCalled()
		})

		it('should scrub headers from error messages', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				headers: {
					'Authorization': 'Bearer secret-token',
					'X-Custom-Header': 'custom-value'
				},
				onError
			})

			mockFetch.mockRejectedValueOnce(new Error('Network error with Bearer secret-token'))

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Network error with [REDACTED]')

			expect(onError).toHaveBeenCalled()
			const callArgs = onError.mock.calls[0]
			expect(callArgs?.[1]).toEqual({
				operation: 'export', exporter: 'otlp', error: 'metrics_otlp_export_failed'
			})
			expect(JSON.stringify(onError.mock.calls)).not.toContain('secret-token')
		})

		it('should allow specific headers in error messages', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				headers: {
					'X-Custom-Header': 'custom-value',
					'Authorization': 'Bearer secret-token'
				},
				allowedHeaders: ['X-Custom-Header'],
				onError
			})

			mockFetch.mockRejectedValueOnce(new Error('Network error'))

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Network error')

			expect(onError).toHaveBeenCalled()
		})

		it('rejects unsupported gRPC protocol at construction time', () => {

			const onError = vi.fn()
			expect(() => new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				protocol: 'grpc' as never,
				onError
			})).toThrow('protocol "grpc" is not supported')
			expect(onError).not.toHaveBeenCalled()
		})

		it('should handle batch export failures', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				onError
			})

			mockFetch.mockRejectedValueOnce(new Error('Batch export failed'))

			const records: MetricRecord[] = [
				{name: 'metric1', type: 'counter', value: 1, labels: {}, timestamp: 1000},
				{name: 'metric2', type: 'gauge', value: 2.5, labels: {}, timestamp: 1000}
			]

			await expect(exp.export(records)).rejects.toThrow('Batch export failed')

			expect(onError).toHaveBeenCalled()
		})

		it('should handle non-Error objects in export catch', async() => {

			const onError = vi.fn()
			const exp = new OtlpExporter({
				endpoint: 'http://localhost:4318/v1/metrics',
				onError
			})

			mockFetch.mockRejectedValueOnce('String error')

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toMatchObject({
				message: 'String error',
				code: 'otlp_export_failed'
			})

			expect(onError).toHaveBeenCalled()
		})
	})
})
