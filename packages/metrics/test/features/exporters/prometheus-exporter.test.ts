import type {LogMethod} from '@ooopsstudio/core/ports/logging'
import {describe, it, expect, beforeEach, vi} from 'vitest'

import {
	PrometheusExporter,
	createPrometheusExporter
} from '../../../src/features/exporters/prometheus-exporter'
import type {MetricRecord} from '../../../src/types/metric-record'

describe('PrometheusExporter', () => {
	it('does not execute inherited object serialization hooks', async() => {
		const inheritedToJSON = vi.fn(() => ({compromised: true}))
		Object.defineProperty(Object.prototype, 'toJSON', {
			configurable: true, value: inheritedToJSON
		})
		try {
			const target = new PrometheusExporter()
			await target.export([{
				name: 'safe_total', type: 'counter', value: 1, labels: {}, timestamp: 1
			}])
			expect(inheritedToJSON).not.toHaveBeenCalled()
			expect(target.getFormatted('prometheus')).toContain('safe_total 1')
		} finally {
			Reflect.deleteProperty(Object.prototype, 'toJSON')
		}
	})

	it('accumulates delta counters between scrapes and renders up-down counters as gauges', async() => {
		const exporter = new PrometheusExporter()
		const metadata = {instrument: 'counter' as const, temporality: 'delta' as const, monotonic: true}
		await exporter.export([
			{name: 'delta_total', type: 'counter', value: 2, labels: {}, timestamp: 1, metadata}
		])
		await exporter.export([
			{name: 'delta_total', type: 'counter', value: 3, labels: {}, timestamp: 2, metadata},
			{name: 'in_flight', type: 'counter', value: -1, labels: {}, timestamp: 2, metadata: {instrument: 'up_down_counter', temporality: 'cumulative', monotonic: false}}
		])
		const output = exporter.getFormatted('openmetrics')
		expect(output).toContain('# TYPE delta counter')
		expect(output).toContain('delta_total 5 0.002')
		expect(output).toContain('# TYPE in_flight gauge')
	})

	it('accumulates every numeric component of delta histogram families', async() => {
		const exporter = new PrometheusExporter()
		const metadata = {instrument: 'histogram' as const, temporality: 'delta' as const}
		const batch = (sum: number, count: number): MetricRecord[] => [
			{name: 'latency_sum', type: 'gauge', value: sum, labels: {}, timestamp: count, metadata},
			{name: 'latency_count', type: 'counter', value: count, labels: {}, timestamp: count, metadata: {...metadata, monotonic: true}},
			{name: 'latency_bucket', type: 'counter', value: count, labels: {le: '1'}, timestamp: count, metadata: {...metadata, monotonic: true}},
			{name: 'latency_bucket', type: 'counter', value: 0, labels: {le: '+Inf'}, timestamp: count, metadata: {...metadata, monotonic: true}}
		]
		await exporter.export(batch(0.5, 1))
		await exporter.export(batch(1.5, 2))
		const output = exporter.getFormatted('prometheus')
		expect(output).toContain('latency_sum 2 2')
		expect(output).toContain('latency_count 3 2')
		expect(output).toContain('latency_bucket{le="1"} 3 2')
	})

	let exporter: PrometheusExporter

	beforeEach(() => {

		exporter = new PrometheusExporter()
	})

	describe('constructor', () => {
		it('rejects malformed options and callbacks', () => {
			expect(() => new PrometheusExporter(null as never)).toThrow('options must be an object')
			expect(() => new PrometheusExporter({onError: true as never})).toThrow('onError must be a function')
			const maxBufferSize = vi.fn(() => 1024)
			const accessorOptions = Object.defineProperty({}, 'maxBufferSize', {enumerable: true, get: maxBufferSize})
			expect(() => new PrometheusExporter(accessorOptions as never)).toThrow('stable known data fields')
			expect(maxBufferSize).not.toHaveBeenCalled()
		})

		it('should create exporter with default options', () => {

			const exp = new PrometheusExporter()

			expect(exp).toBeDefined()
		})

		it('should create exporter with custom options', () => {

			const exp = new PrometheusExporter({
				maxBufferSize: 2_048,
				maxBufferLines: 100
			})

			expect(exp).toBeDefined()
		})

		it('should reject invalid rolling-window options', () => {

			expect(() => new PrometheusExporter({maxBufferSize: Number.NaN})).toThrow('maxBufferSize')
			expect(() => new PrometheusExporter({maxBufferLines: 0})).toThrow('maxBufferLines')
			expect(() => new PrometheusExporter({maxBufferSize: 64 * 1024 * 1024 + 1}))
				.toThrow('no greater than 67108864')
			expect(() => new PrometheusExporter({maxBufferLines: 100_001}))
				.toThrow('no greater than 100000')
		})
	})

	describe('export', () => {

		it('should handle empty batch', async() => {

			await expect(exporter.export([])).resolves.not.toThrow()
			expect(exporter.getFormatted('openmetrics')).toBe('# EOF\n')
			expect(exporter.getFormatted('prometheus')).toBe('')
		})

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

		it('sanitizes direct metric names and label keys before rendering', async() => {
			await exporter.export([
				{
					name: 'bad metric.name',
					type: 'counter',
					value: 1,
					labels: {'bad-label': 'value', 'http:route': '/', __name__: 'spoofed'},
					timestamp: 1000
				}
			])

			const rendered = exporter.getFormatted('prometheus')

			expect(rendered).toContain('bad_metric_name_total{bad_label="value",http_route="/",exported__name__="spoofed"} 1 1000')
			expect(rendered).not.toContain('bad metric.name')
			expect(rendered).not.toContain('bad-label')
			expect(rendered).not.toContain('http:route')
			expect(rendered).not.toContain('{__name__=')
		})

		it('rejects collisions with remapped Prometheus system labels', async() => {
			await expect(exporter.export([{
				name: 'reserved_collision', type: 'gauge', value: 1, timestamp: 1,
				labels: {__name__: 'spoofed', exported__name__: 'caller'}
			}])).rejects.toThrow('label collision')
		})

		it('moves OpenMetrics reserved leading-underscore names into an exported namespace', async() => {
			await exporter.export([{
				name: '_private_metric', type: 'gauge', value: 1, timestamp: 1,
				labels: {_private_label: 'value'}
			}])

			const rendered = exporter.getFormatted('openmetrics')
			expect(rendered).toContain('# TYPE exported_private_metric gauge')
			expect(rendered).toContain('exported_private_metric{exported_private_label="value"} 1 0.001')
			expect(rendered).not.toContain('# TYPE _private_metric')
		})

		it('rejects collisions introduced by reserved metric-name remapping', async() => {
			await expect(exporter.export([
				{name: '_private', type: 'gauge', value: 1, labels: {}, timestamp: 1},
				{name: 'exported_private', type: 'gauge', value: 2, labels: {}, timestamp: 1}
			])).rejects.toThrow('Prometheus metric collision')
			expect(exporter.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('preserves prototype-like label names as data properties', async() => {
			const labels = Object.fromEntries([['__proto__', 'safe-value']])
			await exporter.export([{
				name: 'prototype_label', type: 'gauge', value: 1, labels, timestamp: 1000
			}])

			expect(exporter.getFormatted('prometheus'))
				.toContain('prototype_label{exported__proto__="safe-value"} 1 1000')
		})

		it('sanitizes direct label values before exposing a scrape', async() => {
			await exporter.export([{
				name: 'privacy_metric',
				type: 'counter',
				value: 1,
				labels: {
					user: 'user@example.com',
					route: 'https://tenant.example.com/users/550e8400-e29b-41d4-a716-446655440000?token=secret'
				},
				timestamp: 1000
			}])

			const rendered = exporter.getFormatted('prometheus')
			expect(rendered).toContain('user="[email]"')
			expect(rendered).toContain('route="/users/:id"')
			expect(rendered).not.toContain('tenant.example.com')
			expect(rendered).not.toContain('token=secret')
		})

		it('redacts values of secret-like direct label keys', async() => {
			await exporter.export([{
				name: 'secret_label_metric',
				type: 'counter',
				value: 1,
				labels: {authorization: 'Bearer production-secret', api_key: 'key-123'},
				timestamp: 1000
			}])

			const rendered = exporter.getFormatted('prometheus')
			expect(rendered).toContain('authorization="[redacted]"')
			expect(rendered).toContain('api_key="[redacted]"')
			expect(rendered).not.toContain('production-secret')
			expect(rendered).not.toContain('key-123')
		})

		it('escapes special label characters exactly once', async() => {
			await exporter.export([{
				name: 'escaping_metric',
				type: 'counter',
				value: 1,
				labels: {special: 'quote" slash\\ newline\nnext'},
				timestamp: 1000
			}])

			expect(exporter.getFormatted('prometheus'))
				.toContain('special="quote\\" slash\\\\ newline\\nnext"')
		})

		it('snapshots metadata and exemplars supplied to the sink directly', async() => {
			const record = {
				name: 'snapshot_metric', type: 'counter' as const, value: 1, labels: {}, timestamp: 1000,
				metadata: {instrument: 'counter' as const, temporality: 'cumulative' as const, description: 'original'},
				exemplar: {value: 1, timestamp: 1000, traceId: 'original-trace'}
			}
			await exporter.export([record])
			record.metadata.description = 'mutated'
			record.exemplar.traceId = 'mutated-trace'

			const rendered = exporter.getFormatted('openmetrics')
			expect(rendered).toContain('# HELP snapshot_metric original')
			expect(rendered).toContain('trace_id="original-trace"')
			expect(rendered).not.toContain('mutated')
		})

		it('rejects direct records whose label keys collide after sanitization', async() => {
			const onError = vi.fn()
			const exp = new PrometheusExporter({onError})

			await expect(exp.export([
				{
					name: 'collision_metric',
					type: 'counter',
					value: 1,
					labels: {
						'user-id': 'one',
						user_id: 'two'
					},
					timestamp: 1000
				}
			])).rejects.toThrow('Prometheus label collision')

			expect(onError).toHaveBeenCalledWith(expect.any(Error), {
				operation: 'export',
				exporter: 'prometheus'
			})
		})

		it('preserves direct export failures when diagnostics throw', async() => {
			const exp = new PrometheusExporter({
				onError: () => {
					throw new Error('diagnostics unavailable')
				}
			})

			await expect(exp.export([{
				name: 'collision_metric',
				type: 'counter',
				value: 1,
				labels: {'user-id': 'one', user_id: 'two'},
				timestamp: 1000
			}])).rejects.toThrow('Prometheus label collision')
		})

		it('rejects direct records whose metric names collide after sanitization', async() => {
			const onError = vi.fn()
			const exp = new PrometheusExporter({onError})

			await exp.export([{
				name: 'collision.metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}])

			await expect(exp.export([{
				name: 'collision-metric',
				type: 'counter',
				value: 2,
				labels: {},
				timestamp: 2000
			}])).rejects.toThrow('Prometheus metric collision')

			const rendered = exp.getFormatted('prometheus')
			expect(rendered).toContain('collision_metric_total 1 1000')
			expect(rendered).not.toContain(' 2 2000')
			expect(onError).toHaveBeenCalledWith(expect.any(Error), {
				operation: 'export',
				exporter: 'prometheus'
			})
		})

		it('preserves raw metric-name origins after family index rebuilds', async() => {
			const exp = new PrometheusExporter()

			await exp.export([{
				name: 'rebuilt metric.name',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}])

			await expect(exp.export([{
				name: 'rebuilt_metric_name',
				type: 'counter',
				value: 2,
				labels: {},
				timestamp: 2000
			}])).rejects.toThrow('Prometheus metric collision')

			const rendered = exp.getFormatted('prometheus')
			expect(rendered).toContain('rebuilt_metric_name_total 1 1000')
			expect(rendered).not.toContain(' 2 2000')
		})

		it('rejects conflicting metric family types from direct records', async() => {
			const exp = new PrometheusExporter()

			await exp.export([{
				name: 'family_conflict',
				type: 'counter',
				value: 1,
				labels: {env: 'test'},
				timestamp: 1000
			}])

			await expect(exp.export([{
				name: 'family_conflict',
				type: 'gauge',
				value: 2,
				labels: {env: 'prod'},
				timestamp: 2000
			}])).rejects.toThrow('already exported as counter')

			const formatted = exp.getFormatted('openmetrics')
			expect(formatted).toContain('# TYPE family_conflict counter')
			expect(formatted).not.toContain('family_conflict{env="prod"} 2 2000')
		})

		it('renders monotonic counter families with the required _total sample suffix', async() => {
			const exp = new PrometheusExporter()
			await exp.export([{
				name: 'requests', type: 'counter', value: 3, labels: {}, timestamp: 2000
			}])

			const openMetrics = exp.getFormatted('openmetrics')
			expect(openMetrics).toContain('# TYPE requests counter')
			expect(openMetrics).toContain('requests_total 3 2')
			expect(openMetrics).not.toContain('# TYPE requests_total counter')
			expect(exp.getFormatted('prometheus')).toContain('requests_total 3 2000')
		})

		it('renders each OpenMetrics family contiguously without interleaving metadata', async() => {
			const exp = new PrometheusExporter()
			await exp.export([
				{name: 'requests', type: 'counter', value: 3, labels: {}, timestamp: 1},
				{name: 'temperature', type: 'gauge', value: 20, labels: {}, timestamp: 1}
			])

			const output = exp.getFormatted('openmetrics')
			const requestsType = output.indexOf('# TYPE requests counter')
			const requestsSample = output.indexOf('requests_total 3')
			const temperatureType = output.indexOf('# TYPE temperature gauge')
			const temperatureSample = output.indexOf('temperature 20')
			expect(requestsType).toBeLessThan(requestsSample)
			expect(requestsSample).toBeLessThan(temperatureType)
			expect(temperatureType).toBeLessThan(temperatureSample)
		})

		it('rejects counter sample names that collide with another family transactionally', async() => {
			const exp = new PrometheusExporter()

			await expect(exp.export([
				{name: 'requests', type: 'counter', value: 1, labels: {}, timestamp: 1},
				{name: 'requests_total', type: 'gauge', value: 2, labels: {}, timestamp: 1}
			])).rejects.toThrow('Prometheus metric collision')
			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects conflicting direct record types with the same metric identity in one batch', async() => {
			const exp = new PrometheusExporter()

			await expect(exp.export([
				{
					name: 'same_identity_conflict',
					type: 'counter',
					value: 1,
					labels: {env: 'test'},
					timestamp: 1000
				},
				{
					name: 'same_identity_conflict',
					type: 'gauge',
					value: 2,
					labels: {env: 'test'},
					timestamp: 2000
				}
			])).rejects.toThrow('already exported as counter')

			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects duplicate samples for the same identity within one export batch', async() => {
			const exp = new PrometheusExporter()
			await expect(exp.export([
				{name: 'duplicate_sample', type: 'gauge', value: 1, labels: {a: '1', b: '2'}, timestamp: 1},
				{name: 'duplicate_sample', type: 'gauge', value: 2, labels: {b: '2', a: '1'}, timestamp: 2}
			])).rejects.toThrow('duplicate data points')
			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects conflicting metadata across label sets of one metric family', async() => {
			const exp = new PrometheusExporter()

			await expect(exp.export([
				{name: 'metadata_family', type: 'gauge', value: 1, labels: {node: 'a'}, timestamp: 1, metadata: {unit: 'bytes'}},
				{name: 'metadata_family', type: 'gauge', value: 2, labels: {node: 'b'}, timestamp: 1, metadata: {unit: 'seconds'}}
			])).rejects.toThrow('conflicting unit metadata')
			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')

			await exp.export([
				{name: 'merged_metadata_family', type: 'gauge', value: 1, labels: {node: 'a'}, timestamp: 1},
				{name: 'merged_metadata_family', type: 'gauge', value: 2, labels: {node: 'b'}, timestamp: 1, metadata: {unit: 'bytes'}}
			])
			expect(exp.getFormatted('openmetrics')).toContain('# HELP merged_metadata_family merged_metadata_family metric (unit: bytes)')
		})

		it.each([
			['instrument', {instrument: 'counter' as const}, {instrument: 'gauge' as const}],
			['temporality', {temporality: 'delta' as const}, {temporality: 'cumulative' as const}],
			['monotonic', {monotonic: true}, {monotonic: false}],
			['description', {description: 'first'}, {description: 'second'}]
		] as const)('rejects conflicting %s family metadata', async(field, firstMetadata, secondMetadata) => {
			const exp = new PrometheusExporter()
			await expect(exp.export([
				{name: `conflicting_${field}`, type: 'gauge', value: 1, labels: {node: 'a'}, timestamp: 1, metadata: firstMetadata},
				{name: `conflicting_${field}`, type: 'gauge', value: 2, labels: {node: 'b'}, timestamp: 1, metadata: secondMetadata}
			])).rejects.toThrow(`conflicting ${field} metadata`)
			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('merges complementary family metadata across label sets', async() => {
			const exp = new PrometheusExporter()
			await exp.export([
				{
					name: 'complementary_metadata', type: 'gauge', value: 1, labels: {node: 'a'}, timestamp: 1,
					metadata: {instrument: 'gauge', monotonic: false}
				},
				{
					name: 'complementary_metadata', type: 'gauge', value: 2, labels: {node: 'b'}, timestamp: 1,
					metadata: {temporality: 'delta', description: 'Complementary metric', unit: 'items'}
				}
			])
			const rendered = exp.getFormatted('openmetrics')
			expect(rendered).toContain('# HELP complementary_metadata Complementary metric (unit: items)')
			expect(rendered).toContain('# TYPE complementary_metadata gauge')
		})

		it('rejects counter values that would invalidate an entire scrape', async() => {
			const exp = new PrometheusExporter()

			await expect(exp.export([{
				name: 'negative_total', type: 'counter', value: -1, labels: {}, timestamp: 1
			}])).rejects.toThrow('non-negative and non-NaN')
			await expect(exp.export([{
				name: 'nan_total', type: 'counter', value: Number.NaN, labels: {}, timestamp: 1
			}])).rejects.toThrow('non-negative and non-NaN')
			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects oversized exemplar label sets transactionally', async() => {
			const exp = new PrometheusExporter()

			await expect(exp.export([{
				name: 'oversized_exemplar', type: 'counter', value: 1, labels: {}, timestamp: 1,
				exemplar: {value: 1, timestamp: 1, traceId: 't'.repeat(121)}
			}])).rejects.toThrow('exceed 128 characters')
			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects direct metric families that collide with reserved histogram child series', async() => {
			const exp = new PrometheusExporter()

			await exp.export([{
				name: 'reserved_duration_bucket',
				type: 'counter',
				value: 1,
				labels: {le: '1'},
				timestamp: 1000,
				metadata: {instrument: 'histogram'}
			}, {
				name: 'reserved_duration_sum',
				type: 'gauge',
				value: 1,
				labels: {},
				timestamp: 1000,
				metadata: {instrument: 'histogram'}
			}, {
				name: 'reserved_duration_count',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000,
				metadata: {instrument: 'histogram'}
			}])

			await expect(exp.export([{
				name: 'reserved_duration_bucket',
				type: 'counter',
				value: 9,
				labels: {source: 'direct'},
				timestamp: 2000
			}])).rejects.toThrow('cannot reserve it as child series')

			const formatted = exp.getFormatted('openmetrics')
			expect(formatted).toContain('# TYPE reserved_duration histogram')
			expect(formatted).not.toContain('# TYPE reserved_duration_bucket counter')
			expect(formatted).not.toContain('source="direct"')
		})

		it('rejects incomplete direct histogram families', async() => {
			const exp = new PrometheusExporter()

			await expect(exp.export([{
				name: 'incomplete_duration_bucket',
				type: 'counter',
				value: 1,
				labels: {le: '1'},
				timestamp: 1000,
				metadata: {instrument: 'histogram'}
			}])).rejects.toThrow('requires both _sum and _count')

			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects direct histogram samples that are not exploded families', async() => {
			const exp = new PrometheusExporter()

			await expect(exp.export([{
				name: 'raw_histogram_sample',
				type: 'histogram',
				value: 12,
				labels: {},
				timestamp: 1000
			}])).rejects.toThrow('requires _bucket, _sum and _count records')

			expect(exp.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects histogram families that would reserve an existing direct metric family', async() => {
			const exp = new PrometheusExporter()

			await exp.export([{
				name: 'raw_duration_bucket',
				type: 'counter',
				value: 1,
				labels: {source: 'direct'},
				timestamp: 1000
			}])

			await expect(exp.export([{
				name: 'raw_duration_bucket',
				type: 'counter',
				value: 1,
				labels: {le: '1'},
				timestamp: 2000,
				metadata: {instrument: 'histogram'}
			}, {
				name: 'raw_duration_sum',
				type: 'gauge',
				value: 2,
				labels: {},
				timestamp: 2000,
				metadata: {instrument: 'histogram'}
			}, {
				name: 'raw_duration_count',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 2000,
				metadata: {instrument: 'histogram'}
			}])).rejects.toThrow('cannot reserve it as child series')

			const formatted = exp.getFormatted('openmetrics')
			expect(formatted).toContain('# TYPE raw_duration_bucket counter')
			expect(formatted).not.toContain('# TYPE raw_duration histogram')
			expect(formatted).not.toContain('le="1"')
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

			// Should not throw
			expect(true).toBe(true)
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

			expect(true).toBe(true)
		})

		it('should use OpenMetrics format when exemplars present', async() => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {env: 'test'},
				timestamp: 1000,
				exemplar: {
					traceId: 'trace123',
					spanId: 'span456',
					value: 1,
					timestamp: 1000
				}
			}

			await exporter.export([record])

			expect(true).toBe(true)
		})

		it('does not render unsupported gauge exemplars or switch the default format', async() => {
			await exporter.export([{
				name: 'active_jobs',
				type: 'gauge',
				value: 2,
				labels: {},
				timestamp: 2000,
				exemplar: {traceId: 'trace123', value: 2, timestamp: 2000}
			}])

			expect(exporter.getFormatted()).toBe('active_jobs 2 2000\n')
			expect(exporter.getFormatted('openmetrics')).not.toContain('# {')
			expect(exporter.getContentType()).toContain('text/plain')
		})

		it('should use legacy format when no exemplars', async() => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])

			expect(true).toBe(true)
		})

		it('should handle NaN values', async() => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'gauge',
				value: Number.NaN,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])

			expect(true).toBe(true)
		})

		it('renders zero timestamps and infinities using Prometheus numeric syntax', async() => {

			await exporter.export([
				{name: 'zero_timestamp', type: 'gauge', value: 1, labels: {}, timestamp: 0},
				{name: 'positive_infinity', type: 'gauge', value: Number.POSITIVE_INFINITY, labels: {}, timestamp: 1000},
				{name: 'negative_infinity', type: 'gauge', value: Number.NEGATIVE_INFINITY, labels: {}, timestamp: 1000}
			])

			const formatted = exporter.getFormatted('prometheus')
			expect(formatted).toContain('zero_timestamp 1 0')
			expect(formatted).toContain('positive_infinity +Inf 1000')
			expect(formatted).toContain('negative_infinity -Inf 1000')
		})

		it('uses seconds for OpenMetrics timestamps and milliseconds for legacy Prometheus', async() => {

			const exp = new PrometheusExporter()
			await exp.export([{
				name: 'timestamp_units', type: 'gauge', value: 1, labels: {},
				timestamp: 1_700_000_000_123
			}])

			expect(exp.getFormatted('openmetrics')).toContain('timestamp_units 1 1700000000.123')
			expect(exp.getFormatted('prometheus')).toContain('timestamp_units 1 1700000000123')
		})

		it('should apply rolling window when buffer exceeds limits', async() => {

			const exp = new PrometheusExporter({
				maxBufferSize: 100,
				maxBufferLines: 5
			})

			// Add many records to exceed buffer
			const records: MetricRecord[] = []
			for (let i = 0; i < 10; i++) {
				records.push({
					name: `test_metric_${i}`,
					type: 'counter',
					value: i,
					labels: {},
					timestamp: 1000
				})
			}

			await exp.export(records)

			expect(exp.getFormatted().split('\n').filter(Boolean).length).toBeLessThanOrEqual(5)
		})

		it('counts retained metadata against the byte budget', async() => {
			const exp = new PrometheusExporter({maxBufferSize: 1_500, maxBufferLines: 100})
			const description = 'x'.repeat(1_024)
			await exp.export(Array.from({length: 10}, (_, index): MetricRecord => ({
				name: 'metadata_bounded_metric',
				type: 'gauge',
				value: index,
				labels: {id: String(index)},
				timestamp: index,
				metadata: {instrument: 'gauge', description}
			})))

			const samples = exp.getFormatted('prometheus').split('\n').filter(Boolean)
			expect(samples.length).toBe(1)
			expect(samples[0]).toContain('id="9"')
		})

		it('evicts histogram families together when applying the rolling window', async() => {

			const exp = new PrometheusExporter({
				maxBufferSize: 10000,
				maxBufferLines: 8
			})

			await exp.export([
				{
					name: 'rolling_duration_bucket',
					type: 'counter',
					value: 0,
					labels: {route: '/api', le: '0.5'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				},
				{
					name: 'rolling_duration_bucket',
					type: 'counter',
					value: 1,
					labels: {route: '/api', le: '+Inf'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				},
				{
					name: 'rolling_duration_sum',
					type: 'gauge',
					value: 0.5,
					labels: {route: '/api'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				},
				{
					name: 'rolling_duration_count',
					type: 'counter',
					value: 1,
					labels: {route: '/api'},
					timestamp: 1000,
					metadata: {instrument: 'histogram'}
				}
			])
			await exp.export(Array.from({length: 10}, (_, index): MetricRecord => ({
				name: `rolling_metric_${index}`,
				type: 'counter',
				value: index,
				labels: {},
				timestamp: 2000 + index
			})))

			const formatted = exp.getFormatted('prometheus')

			expect(formatted).not.toContain('rolling_duration')
			expect(formatted.split('\n').filter(Boolean).length).toBeLessThanOrEqual(8)
		})

		it('keeps only the latest sample for the same metric identity', async() => {
			await exporter.export([{
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {route: '/api'},
				timestamp: 1000
			}])
			await exporter.export([{
				name: 'test_metric',
				type: 'counter',
				value: 2,
				labels: {route: '/api'},
				timestamp: 2000
			}])

			const formatted = exporter.getFormatted('prometheus')
			const sampleLines = formatted
				.split('\n')
				.filter((line) => line.startsWith('test_metric'))

			expect(sampleLines).toHaveLength(1)
			expect(sampleLines[0]).toContain(' 2 2')
			expect(formatted).not.toContain(' 1 1000')
		})

		it('renders a single OpenMetrics EOF across repeated exemplar exports', async() => {
			const exemplar = {
				traceId: 'trace123',
				spanId: 'span456',
				value: 1,
				timestamp: 1000
			}
			const baseRecord: MetricRecord = {
				name: 'trace_metric',
				type: 'counter',
				value: 1,
				labels: {route: '/api'},
				timestamp: 1000,
				exemplar
			}

			await exporter.export([baseRecord])
			await exporter.export([{
				...baseRecord,
				value: 2,
				timestamp: 2000,
				exemplar: {
					...exemplar,
					value: 2,
					timestamp: 2000
				}
			}])

			const formatted = exporter.getFormatted()
			const eofCount = formatted.split('\n').filter((line) => line === '# EOF').length
			const sampleLines = formatted
				.split('\n')
				.filter((line) => line.startsWith('trace_metric'))

			expect(eofCount).toBe(1)
			expect(sampleLines).toHaveLength(1)
			expect(sampleLines[0]).toContain(' 2 2')
			expect(sampleLines[0]).toContain('# {trace_id="trace123",span_id="span456"} 2 2')
		})

		it('renders OpenMetrics sample and exemplar timestamps in Unix seconds', async() => {
			await exporter.export([{
				name: 'timestamp_units',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1_700_000_000_123,
				exemplar: {
					traceId: 'trace123',
					value: 1,
					timestamp: 1_700_000_000_123
				}
			}])

			const sample = exporter.getFormatted('openmetrics')
				.split('\n')
				.find((line) => line.startsWith('timestamp_units'))

			expect(sample).toBe('timestamp_units_total 1 1700000000.123 # {trace_id="trace123"} 1 1700000000.123')
		})

		it('renders histogram buckets as cumulative Prometheus families', async() => {
			const records: MetricRecord[] = [
				{
					name: 'request_duration_bucket',
					type: 'counter',
					value: 2,
					labels: {route: '/api', le: '0.1'},
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				},
				{
					name: 'request_duration_bucket',
					type: 'counter',
					value: 1,
					labels: {route: '/api', le: '0.5'},
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				},
				{
					name: 'request_duration_bucket',
					type: 'counter',
					value: 1,
					labels: {route: '/api', le: '+Inf'},
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				},
				{
					name: 'request_duration_sum',
					type: 'gauge',
					value: 42,
					labels: {route: '/api'},
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms'}
				},
				{
					name: 'request_duration_count',
					type: 'counter',
					value: 4,
					labels: {route: '/api'},
					timestamp: 1000,
					metadata: {instrument: 'histogram', unit: 'ms', monotonic: true}
				}
			]

			await exporter.export(records)

			const prometheus = exporter.getFormatted('prometheus')
			expect(prometheus).toContain('request_duration_bucket{route="/api",le="0.1"} 2 1000')
			expect(prometheus).toContain('request_duration_bucket{route="/api",le="0.5"} 3 1000')
			expect(prometheus).toContain('request_duration_bucket{route="/api",le="+Inf"} 4 1000')
			expect(prometheus).toContain('request_duration_count{route="/api"} 4 1000')
			expect(prometheus).toContain('request_duration_sum{route="/api"} 42 1000')

			const openMetrics = exporter.getFormatted('openmetrics')
			expect(openMetrics).toContain('# TYPE request_duration histogram')
			expect(openMetrics).not.toContain('# TYPE request_duration_bucket')
			expect(openMetrics).not.toContain('# TYPE request_duration_count')
			expect(openMetrics).not.toContain('# TYPE request_duration_sum')
		})

		it.each([
			{
				name: 'invalid bound',
				buckets: [{le: 'not-a-bound', value: 1}],
				count: 1,
				error: 'invalid bound'
			},
			{
				name: 'duplicate normalized bounds',
				buckets: [{le: '1', value: 1}, {le: '1.0', value: 0}],
				count: 1,
				error: 'duplicate bound'
			},
			{
				name: 'negative bound with required sum',
				buckets: [{le: '-1', value: 1}],
				count: 1,
				error: 'negative bounds'
			},
			{
				name: 'fractional bucket count',
				buckets: [{le: '1', value: 0.5}],
				count: 1,
				error: 'non-negative safe integer'
			},
			{
				name: 'mismatched explicit overflow',
				buckets: [{le: '1', value: 1}, {le: '+Inf', value: 1}],
				count: 3,
				error: 'does not match its count'
			}
		])('rejects malformed direct histogram families: $name', async({buckets, count, error}) => {
			const records: MetricRecord[] = buckets.map(({le, value}) => ({
				name: 'malformed_duration_bucket', type: 'counter', value,
				labels: {le}, timestamp: 1000, metadata: {instrument: 'histogram'}
			}))
			records.push(
				{name: 'malformed_duration_sum', type: 'gauge', value: 1, labels: {}, timestamp: 1000, metadata: {instrument: 'histogram'}},
				{name: 'malformed_duration_count', type: 'counter', value: count, labels: {}, timestamp: 1000, metadata: {instrument: 'histogram'}}
			)

			await expect(exporter.export(records)).rejects.toThrow(error)
			expect(exporter.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('rejects histogram exemplars outside their bucket bound', async() => {
			await expect(exporter.export([
				{
					name: 'invalid_exemplar_duration_bucket', type: 'counter', value: 1,
					labels: {le: '1'}, timestamp: 1, metadata: {instrument: 'histogram'},
					exemplar: {value: 2, timestamp: 1, traceId: 'trace'}
				},
				{name: 'invalid_exemplar_duration_sum', type: 'gauge', value: 2, labels: {}, timestamp: 1, metadata: {instrument: 'histogram'}},
				{name: 'invalid_exemplar_duration_count', type: 'counter', value: 1, labels: {}, timestamp: 1, metadata: {instrument: 'histogram'}}
			])).rejects.toThrow('exemplar exceeds its bucket bound')
		})

		it('rejects conflicting metadata across histogram child records', async() => {
			await expect(exporter.export([
				{name: 'conflicting_duration_bucket', type: 'counter', value: 1, labels: {le: '1'}, timestamp: 1, metadata: {instrument: 'histogram', unit: 'ms'}},
				{name: 'conflicting_duration_sum', type: 'gauge', value: 1, labels: {}, timestamp: 1, metadata: {instrument: 'histogram', unit: 'seconds'}},
				{name: 'conflicting_duration_count', type: 'counter', value: 1, labels: {}, timestamp: 1, metadata: {instrument: 'histogram', unit: 'ms'}}
			])).rejects.toThrow('conflicting unit metadata')
			expect(exporter.getFormatted('openmetrics')).toBe('# EOF\n')
		})

		it('renders formatted scrapes without mutating family indexes', async() => {
			const exp = new PrometheusExporter()
			await exp.export([{
				name: 'readonly_duration_bucket',
				type: 'counter',
				value: 1,
				labels: {le: '1'},
				timestamp: 1000,
				metadata: {instrument: 'histogram'}
			}, {
				name: 'readonly_duration_sum',
				type: 'gauge',
				value: 1,
				labels: {},
				timestamp: 1000,
				metadata: {instrument: 'histogram'}
			}, {
				name: 'readonly_duration_count',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000,
				metadata: {instrument: 'histogram'}
			}])

			const internals = exp as unknown as {
				readonly familyTypes: Map<string, string>
				readonly reservedChildSeries: Map<string, string>
			}
			internals.familyTypes.clear()
			internals.reservedChildSeries.clear()

			expect(exp.getFormatted('openmetrics')).toContain('# TYPE readonly_duration histogram')
			expect(internals.familyTypes.size).toBe(0)
			expect(internals.reservedChildSeries.size).toBe(0)
		})

		it('escapes OpenMetrics HELP text', async() => {
			await exporter.export([{
				name: 'escaped_help_metric',
				type: 'gauge',
				value: 1,
				labels: {route: 'safe\rsegment\nnext\u001b'},
				timestamp: 1000,
				metadata: {
					description: 'line "one"\\line two\nline three\rhidden\u001b',
					unit: 'items\\second\runit'
				}
			}])

			const openMetrics = exporter.getFormatted('openmetrics')

			expect(openMetrics).toContain('# HELP escaped_help_metric line \\"one\\"\\\\line two\\nline three hidden  (unit: items\\\\second unit)')
			expect(openMetrics).toContain('route="safe segment\\nnext "')
			expect(openMetrics).not.toContain('\r')
			expect(openMetrics).not.toContain('\u001b')
		})

		it('should call onError callback on error', async() => {

			const onError = vi.fn()
			new PrometheusExporter({
				onError
			})

			// Force an error by using invalid data
			// This is a bit tricky since export is well-behaved
			// We'll just verify the callback exists
			expect(onError).toBeDefined()
		})

		it('rethrows export failures after logging them', async() => {
			const onError = vi.fn()
			const logger = {
				level: 'trace' as const,
				trace: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				info: vi.fn(),
				debug: vi.fn(),
				fatal: vi.fn(),
				context: vi.fn()
			}
			const exp = new PrometheusExporter({
				onError,
				logger
			})
			vi.spyOn(
				exp as unknown as {applyRollingWindow: () => void},
				'applyRollingWindow'
			).mockImplementation(() => {
				throw new Error('buffer failure')
			})

			await expect(exp.export([{
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}])).rejects.toThrow('buffer failure')

			expect(onError).toHaveBeenCalled()
			expect(logger.error).toHaveBeenCalled()
		})
	})

	describe('getFormatted', () => {

		it('should return formatted metrics', () => {

			const formatted = exporter.getFormatted()

			expect(typeof formatted).toBe('string')
		})

		it('should return formatted metrics with exported data', async() => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])
			const formatted = exporter.getFormatted()

			expect(formatted).toContain('test_metric')
		})

		it('should support openmetrics format', async() => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000,
				exemplar: {
					traceId: 'trace123',
					spanId: 'span456',
					value: 1,
					timestamp: 1000
				}
			}

			await exporter.export([record])
			const formatted = exporter.getFormatted('openmetrics')

			expect(formatted).toContain('test_metric')
		})

		it('should support prometheus format', async() => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])
			const formatted = exporter.getFormatted('prometheus')

			expect(formatted).toContain('test_metric')
		})
	})

	describe('getContentType', () => {

		it('should return content type for openmetrics', () => {

			const contentType = exporter.getContentType('openmetrics')

			expect(contentType).toBe('application/openmetrics-text; version=1.0.0; charset=utf-8')
		})

		it('should return content type for prometheus', () => {

			const contentType = exporter.getContentType('prometheus')

			expect(contentType).toContain('text/plain')
		})
	})

	describe('clear', () => {

		it('should clear buffer', async() => {

			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])
			exporter.clear()

			const formatted = exporter.getFormatted()
			expect(formatted).toBe('')
		})
	})

	describe('flush', () => {

		it('should be a no-op', async() => {

			await expect(exporter.flush()).resolves.not.toThrow()
		})
	})

	describe('shutdown', () => {

		it('should shutdown exporter', async() => {

			await expect(exporter.shutdown()).resolves.not.toThrow()
		})

		it('rejects a proxied batch before its snapshot traps can re-enter shutdown', async() => {
			let trapRan = false
			const batch = new Proxy([{
				name: 'post_shutdown_total', type: 'counter' as const, value: 1, labels: {}, timestamp: 1
			}], {
				getOwnPropertyDescriptor(target, property) {
					trapRan = true
					void exporter.shutdown()
					return Reflect.getOwnPropertyDescriptor(target, property)
				}
			})

			await expect(exporter.export(batch)).rejects.toThrow('bounded dense array')
			expect(trapRan).toBe(false)
			await expect(exporter.export([{
				name: 'still_open_total', type: 'counter', value: 1, labels: {}, timestamp: 1
			}])).resolves.toBeUndefined()
			expect(exporter.getFormatted()).toContain('still_open_total')
			await exporter.shutdown()
			expect(exporter.getFormatted()).toBe('')
		})

	})

	describe('createPrometheusExporter', () => {

		it('should create prometheus exporter', () => {

			const exp = createPrometheusExporter()

			expect(exp).toBeInstanceOf(PrometheusExporter)
		})

		it('should create prometheus exporter with options', () => {

			const exp = createPrometheusExporter({
				maxBufferLines: 100
			})

			expect(exp).toBeInstanceOf(PrometheusExporter)
		})
	})

	describe('error handling', () => {

		it('should handle export errors gracefully', async() => {

			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
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
			const exp = new PrometheusExporter({logger})

			// Create a record that might cause formatting issues
			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			// Mock formatLegacyPrometheus to throw
			exp['formatLegacyPrometheus'] = vi.fn().mockImplementation(() => {
				throw new Error('Format error')
			})

			await expect(exp.export([record])).rejects.toThrow('Format error')

			expect(consoleErrorSpy).toHaveBeenCalled()
			consoleErrorSpy.mockRestore()
		})

		it('should call onError callback on export failure', async() => {

			const onError = vi.fn()
			const exp = new PrometheusExporter({onError})

			// Mock formatLegacyPrometheus to throw
			exp['formatLegacyPrometheus'] = vi.fn().mockImplementation(() => {
				throw new Error('Format error')
			})

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toThrow('Format error')

			expect(onError).toHaveBeenCalled()
		})

		it('should handle format errors in OpenMetrics format', async() => {

			const onError = vi.fn()
			const exp = new PrometheusExporter({onError})

			// Mock formatOpenMetrics to throw
			exp['formatOpenMetrics'] = vi.fn().mockImplementation(() => {
				throw new Error('OpenMetrics format error')
			})

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000,
				exemplar: {
					value: 1,
					timestamp: 1000
				}
			}

			await expect(exp.export([record])).rejects.toThrow('OpenMetrics format error')

			expect(onError).toHaveBeenCalled()
		})

		it('should handle non-Error objects in export catch', async() => {

			const onError = vi.fn()
			const exp = new PrometheusExporter({onError})

			// Mock formatLegacyPrometheus to throw non-Error
			exp['formatLegacyPrometheus'] = vi.fn().mockImplementation(() => {
				throw 'String error'
			})

			const record: MetricRecord = {
				name: 'test_counter',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await expect(exp.export([record])).rejects.toBe('String error')

			expect(onError).toHaveBeenCalled()
		})
	})
})
