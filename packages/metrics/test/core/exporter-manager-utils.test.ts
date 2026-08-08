import {describe, expect, it, vi} from 'vitest'

import {
	assertValidExportResult,
	extractFailedRecords,
	extractHttpStatus,
	extractRetryAfterMs,
	isOperationTimeoutError,
	isPartialExportResult,
	isRetryableExportFailure,
	isTransientFailure,
	splitMetricBatch,
	stableSerialize,
	toExportError,
	toMetricsExportError
} from '../../src/core/exporter-manager-utils'
import {MetricsOperationTimeoutError} from '../../src/core/operation-timeout'
import type {MetricRecord} from '../../src/types'

const record: MetricRecord = {name: 'metric', type: 'counter', value: 1, labels: {}, timestamp: 1}

describe('exporter manager utility edges', () => {
	it('serializes values and validates every export result shape', () => {
		expect(stableSerialize(undefined)).toBe('undefined')
		expect(stableSerialize(Symbol('value'))).toContain('symbol:')
		expect(stableSerialize([2, {b: 1, a: null}])).toBe('[2,{"a":null,"b":1}]')
		expect(stableSerialize(1n)).toBe('bigint:1')
		expect(stableSerialize(-0)).toBe('-0')
		expect(stableSerialize(Number.NaN)).toBe('number:NaN')
		expect(stableSerialize(Number.POSITIVE_INFINITY)).toBe('number:Infinity')
		const functionCoercion = vi.fn(() => 'secret')
		const hostileFunction = Object.assign(() => undefined, {toString: functionCoercion})
		expect(() => stableSerialize(hostileFunction)).toThrow('stable data fields')
		expect(functionCoercion).not.toHaveBeenCalled()
		const hostileMap = vi.fn(() => ['secret'])
		const array = [1, 2]
		Object.defineProperty(array, 'map', {enumerable: true, value: hostileMap})
		expect(() => stableSerialize(array)).toThrow('stable data fields')
		expect(hostileMap).not.toHaveBeenCalled()
		const cyclic: {self?: unknown} = {}
		cyclic.self = cyclic
		expect(() => stableSerialize(cyclic)).toThrow('cyclic')
		const getter = vi.fn(() => 1)
		const hostile = Object.defineProperty({}, 'value', {enumerable: true, get: getter})
		expect(() => stableSerialize(hostile)).toThrow('stable data fields')
		expect(getter).not.toHaveBeenCalled()
		expect(isPartialExportResult({status: 'partial', failedRecords: [record]})).toBe(true)
		expect(isPartialExportResult(undefined)).toBe(false)
		expect(() => assertValidExportResult(null as never, [record])).toThrow(/invalid export result/)
		expect(() => assertValidExportResult({status: 'success', failedRecords: [record]} as never, [record])).toThrow(/must not include/)
		expect(() => assertValidExportResult({status: 'unknown'} as never, [record])).toThrow(/unsupported/)
		const statusCoercion = vi.fn(() => 'success')
		expect(() => assertValidExportResult({status: {toString: statusCoercion}} as never, [record]))
			.toThrow('unsupported export status "<object>"')
		expect(statusCoercion).not.toHaveBeenCalled()
		expect(assertValidExportResult({
			status: 'partial', failedRecords: [record], retryAfterMs: Number.MAX_VALUE
		}, [record])).toMatchObject({retryAfterMs: 2_147_483_647})
		expect(() => assertValidExportResult({
			status: 'partial', failedRecords: [record], retryAfterMs: Number.NaN
		}, [record])).toThrow('non-negative finite')
		expect(() => assertValidExportResult({status: 'success', extra: true} as never, [record]))
			.toThrow('stable known data fields')
		const item = vi.fn(() => record)
		const failedRecords = Object.defineProperty([], '0', {enumerable: true, get: item})
		expect(() => assertValidExportResult({status: 'partial', failedRecords} as never, [record]))
			.toThrow('bounded stable')
		expect(item).not.toHaveBeenCalled()
	})

	it('extracts typed HTTP/retry metadata and failed records', () => {
		expect(extractHttpStatus({statusCode: 429})).toBe(429)
		expect(extractHttpStatus({status: 503})).toBe(503)
		expect(extractHttpStatus({response: {status: 401}})).toBe(401)
		expect(extractHttpStatus(new Error('request failed with 502'))).toBe(502)
		expect(extractHttpStatus('offline')).toBeUndefined()
		expect(extractRetryAfterMs({retryAfterMs: 10})).toBe(10)
		expect(extractRetryAfterMs({retryAfterMs: Number.MAX_VALUE})).toBe(2_147_483_647)
		expect(extractRetryAfterMs({retryAfterMs: -1})).toBeUndefined()
		expect(extractFailedRecords({failedRecords: [record]}, [record])).toEqual([record])
		expect(extractFailedRecords({}, [record])).toEqual([record])
	})

	it('classifies failures and fills typed export errors', () => {
		expect(toExportError('bad', 'fallback').message).toBe('fallback')
		expect(isOperationTimeoutError(
			new MetricsOperationTimeoutError('exporter-flush', 'Metrics exporter flush timed out after 1ms'),
			'flush'
		)).toBe(true)
		expect(isOperationTimeoutError(new Error('Metrics exporter flush timed out after 1ms'), 'flush')).toBe(false)
		expect(isOperationTimeoutError(
			new MetricsOperationTimeoutError('exporter-shutdown', 'same text'),
			'flush'
		)).toBe(false)
		expect(isTransientFailure({retryable: false})).toBe(false)
		expect(isTransientFailure(new Error('ECONNRESET'))).toBe(true)
		expect(isTransientFailure({statusCode: 408})).toBe(true)
		expect(isRetryableExportFailure({statusCode: 400})).toBe(false)
		expect(isRetryableExportFailure({statusCode: 500})).toBe(true)
		expect(isRetryableExportFailure({})).toBe(true)
		const typed = toMetricsExportError({status: 429, retryAfterMs: 20}, 'failed', 'fallback')
		expect(typed).toMatchObject({statusCode: 429, retryAfterMs: 20, retryable: true, code: 'http_429'})
		const frozen = Object.freeze(Object.assign(new Error('frozen failure'), {retryable: false}))
		expect(toMetricsExportError(frozen, 'failed', 'fallback')).toMatchObject({
			message: 'frozen failure', retryable: false, code: 'fallback'
		})
		const getter = vi.fn(() => 503)
		const hostile = Object.defineProperty({}, 'statusCode', {get: getter})
		expect(extractHttpStatus(hostile)).toBeUndefined()
		expect(getter).not.toHaveBeenCalled()
	})

	it('splits by count and bytes and handles empty batches', () => {
		expect(splitMetricBatch([], 1, 100)).toEqual([])
		expect(splitMetricBatch([record, {...record, name: 'two'}], 1, 10_000)).toHaveLength(2)
		expect(() => splitMetricBatch([record], 10, 1)).toThrow('exceeds exporter maxBatchBytes')
		expect(() => splitMetricBatch([{
			...record,
			metadata: {description: 'x'.repeat(256), instrument: 'counter'}
		}], 10, 128)).toThrow('exceeds exporter maxBatchBytes')
	})
})
