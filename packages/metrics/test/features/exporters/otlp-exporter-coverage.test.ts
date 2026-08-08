import {describe, expect, it, vi} from 'vitest'

import {OtlpExporter} from '../../../src/features/exporters/otlp-exporter'
describe('otlp exporter coverage', () => {

	it('rejects unsupported grpc protocol', () => {
		expect(() => new OtlpExporter({
			endpoint: 'http://localhost:4318/v1/metrics',
			protocol: 'grpc' as never
		})).toThrow('protocol "grpc" is not supported')
	})

	it('covers non-ok HTTP responses with retry-after metadata', async() => {
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: 'Too Many Requests',
			headers: {
				get: vi.fn().mockReturnValue('2')
			}
		} as unknown as Response) as typeof fetch

		const exporter = new OtlpExporter({
			endpoint: 'http://localhost:4318/v1/metrics'
		})

		await expect(exporter.export([{
			name: 'retry_metric',
			type: 'counter',
			value: 1,
			labels: {},
			timestamp: 1_000
		}])).rejects.toThrow('OTLP export failed: 429 Too Many Requests')

		global.fetch = originalFetch
	})

	it('bounds excessive Retry-After values to the maximum supported timer', async() => {
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: 'Too Many Requests',
			headers: {get: vi.fn().mockReturnValue('1e300')}
		} as unknown as Response) as typeof fetch
		const exporter = new OtlpExporter({endpoint: 'http://localhost:4318/v1/metrics'})

		await expect(exporter.export([{
			name: 'bounded_retry_metric', type: 'counter', value: 1, labels: {}, timestamp: 1
		}])).rejects.toMatchObject({retryAfterMs: 2_147_483_647})

		global.fetch = originalFetch
	})

	it('supports HTTP-date Retry-After values', async() => {
		const originalFetch = global.fetch
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00.000Z'))
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			statusText: 'Unavailable',
			headers: {get: vi.fn().mockReturnValue('Thu, 01 Jan 2026 00:00:02 GMT')}
		} as unknown as Response) as typeof fetch
		const exporter = new OtlpExporter({endpoint: 'http://localhost:4318/v1/metrics'})

		await expect(exporter.export([{
			name: 'retry_metric', type: 'counter', value: 1, labels: {}, timestamp: 1
		}])).rejects.toMatchObject({retryAfterMs: 2_000})

		vi.restoreAllMocks()
		global.fetch = originalFetch
	})

	it('projects non-Error transport failures into bounded safe errors', async() => {
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockRejectedValue('token\n' + 'x'.repeat(2_000)) as typeof fetch
		const exporter = new OtlpExporter({endpoint: 'http://localhost:4318/v1/metrics'})

		const failure = await exporter.export([{
			name: 'safe_metric', type: 'counter', value: 1, labels: {}, timestamp: 1
		}]).catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).not.toContain('\n')
		expect((failure as Error).message.length).toBeLessThanOrEqual(1_024)
		global.fetch = originalFetch
	})

	it('does not execute coercion hooks from hostile transport failures', async() => {
		const originalFetch = global.fetch
		const coercion = vi.fn(() => 'secret-token')
		global.fetch = vi.fn().mockRejectedValue({toString: coercion}) as typeof fetch
		const exporter = new OtlpExporter({endpoint: 'http://localhost:4318/v1/metrics'})

		await expect(exporter.export([{
			name: 'safe_metric', type: 'counter', value: 1, labels: {}, timestamp: 1
		}])).rejects.toThrow('OTLP transport failed')
		expect(coercion).not.toHaveBeenCalled()
		global.fetch = originalFetch
	})
})
