/**
 * @file Tests for console exporter.
 */

import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'
import {createMonotonicClock} from '@ooopsstudio/core/runtime/time/monotonic-clock'
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'

import {createConsoleExporter} from '../../../src/features/exporters/console-exporter'

describe('createConsoleExporter', () => {

	let originalConsoleLog: typeof console.log

	beforeEach(() => {

		originalConsoleLog = console.log
		console.log = vi.fn()
	})

	afterEach(() => {

		console.log = originalConsoleLog
	})

	it('should create a console exporter', () => {

		const exporter = createConsoleExporter()
		expect(exporter).toBeDefined()
		expect(exporter.export).toBeDefined()
		expect(exporter.shutdown).toBeDefined()
	})

	it('rejects accessor-backed options and Proxy batches without invoking traps', async() => {
		const color = vi.fn(() => true)
		const accessor = Object.defineProperty({}, 'color', {enumerable: true, get: color})
		expect(() => createConsoleExporter(accessor)).toThrow('closed plain data object')
		expect(color).not.toHaveBeenCalled()

		const length = vi.fn(() => 1)
		const batch = new Proxy([], {get: (_target, key) => key === 'length' ? length() : undefined})
		const exporter = createConsoleExporter()
		await expect(exporter.export(batch)).resolves.toMatchObject({status: 'permanent-failure'})
		expect(length).not.toHaveBeenCalled()
		expect(console.log).not.toHaveBeenCalled()
	})

	it('should export spans to console', async() => {

		const exporter = createConsoleExporter()
		const clock = createMonotonicClock()

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			startTime: clock.now(),
			endTime: clock.now(),
			durationMs: 0,
			attributes: {},
			status: {code: 'ok'},
			events: []
		}

		await exporter.export([span])

		expect(console.log).toHaveBeenCalled()
	})

	it('should support shutdown', async() => {

		const exporter = createConsoleExporter()

		await expect(exporter.shutdown()).resolves.not.toThrow()
	})

	it('should handle color option', async() => {

		const exporter = createConsoleExporter({color: true})
		const clock = createMonotonicClock()

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			startTime: clock.now(),
			endTime: clock.now(),
			durationMs: 0,
			attributes: {},
			status: {code: 'ok'},
			events: []
		}

		await exporter.export([span])

		expect(console.log).toHaveBeenCalled()
	})

	it('should handle color disabled', async() => {

		const exporter = createConsoleExporter({color: false})
		const clock = createMonotonicClock()

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			startTime: clock.now(),
			endTime: clock.now(),
			durationMs: 0,
			attributes: {},
			status: {code: 'ok'},
			events: []
		}

		await exporter.export([span])

		expect(console.log).toHaveBeenCalled()
	})

	it('should handle error status', async() => {

		const exporter = createConsoleExporter({color: true})
		const clock = createMonotonicClock()

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			startTime: clock.now(),
			endTime: clock.now(),
			durationMs: 0,
			attributes: {},
			status: {code: 'error'},
			events: []
		}

		await exporter.export([span])

		expect(console.log).toHaveBeenCalled()
	})

	it('should handle unset status', async() => {

		const exporter = createConsoleExporter({color: true})
		const clock = createMonotonicClock()

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			startTime: clock.now(),
			endTime: clock.now(),
			durationMs: 0,
			attributes: {},
			status: {code: 'unset'},
			events: []
		}

		await exporter.export([span])

		expect(console.log).toHaveBeenCalled()
	})

	it('should handle empty span array', async() => {

		const exporter = createConsoleExporter()

		await exporter.export([])

		expect(console.log).not.toHaveBeenCalled()
	})

	it('should handle span without durationMs', async() => {

		const exporter = createConsoleExporter()
		const clock = createMonotonicClock()

		const span: SpanRecord = {
			name: 'test.span',
			kind: 'internal',
			context: {
				traceId: '1234567890abcdef1234567890abcdef',
				spanId: '1234567890abcdef',
				traceFlags: 1
			},
			startTime: clock.now(),
			endTime: clock.now(),
			attributes: {},
			status: {code: 'ok'},
			events: []
		}

		await exporter.export([span])

		expect(console.log).toHaveBeenCalled()
	})
})
