import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'

import {ConsoleExporter, createConsoleExporter} from '../../../src/features/exporters/console-exporter'
import type {MetricRecord} from '../../../src/types/metric-record'

describe('ConsoleExporter', () => {

	let consoleLogSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {

		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
	})

	afterEach(() => {

		consoleLogSpy.mockRestore()
	})

	describe('constructor', () => {
		it('rejects malformed options', () => {
			expect(() => new ConsoleExporter(null as never)).toThrow('options must be an object')
			expect(() => new ConsoleExporter({color: 'yes' as never})).toThrow('color must be a boolean')
			const colorGetter = vi.fn(() => true)
			const accessorOptions = Object.defineProperty({}, 'color', {enumerable: true, get: colorGetter})
			expect(() => new ConsoleExporter(accessorOptions as never)).toThrow('stable known data fields')
			expect(colorGetter).not.toHaveBeenCalled()
		})

		it('should create exporter with default color detection', () => {

			const exporter = new ConsoleExporter()

			expect(exporter).toBeDefined()
		})

		it('should create exporter with color enabled', () => {

			const exporter = new ConsoleExporter({color: true})

			expect(exporter).toBeDefined()
		})

		it('should create exporter with color disabled', () => {

			const exporter = new ConsoleExporter({color: false})

			expect(exporter).toBeDefined()
		})
	})

	describe('export', () => {

		it('should handle empty batch', async() => {

			const exporter = new ConsoleExporter()

			await exporter.export([])

			expect(consoleLogSpy).not.toHaveBeenCalled()
		})

		it('should export single metric', async() => {

			const exporter = new ConsoleExporter({color: false})
			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])

			expect(consoleLogSpy).toHaveBeenCalled()
			const calls = consoleLogSpy.mock.calls
			expect(calls[0]?.[0]).toContain('test_metric')
			expect(calls[1]?.[0]).toContain('counter')
			expect(calls[1]?.[0]).toContain('1')
		})

		it('should group metrics by name', async() => {

			const exporter = new ConsoleExporter({color: false})
			const records: MetricRecord[] = [
				{name: 'test_metric', type: 'counter', value: 1, labels: {}, timestamp: 1000},
				{name: 'test_metric', type: 'counter', value: 2, labels: {env: 'test'}, timestamp: 1000}
			]

			await exporter.export(records)

			expect(consoleLogSpy).toHaveBeenCalled()
			const calls = consoleLogSpy.mock.calls
			// Should have one name line (first call) and two record lines (subsequent calls)
			// All calls should contain 'test_metric' since they're grouped
			expect(calls.length).toBeGreaterThanOrEqual(2)
			expect(calls[0]?.[0]).toContain('test_metric')
		})

		it('should format labels correctly', async() => {

			const exporter = new ConsoleExporter({color: false})
			const record: MetricRecord = {
				name: 'test_metric',
				type: 'gauge',
				value: 42.5,
				labels: {env: 'test', service: 'api'},
				timestamp: 1000
			}

			await exporter.export([record])

			expect(consoleLogSpy).toHaveBeenCalled()
			const calls = consoleLogSpy.mock.calls
			const recordLine = calls.find((call) => typeof call[0] === 'string' && call[0].includes('gauge'))
			expect(recordLine?.[0]).toBeDefined()
			if (recordLine?.[0] && typeof recordLine[0] === 'string') {
				expect(recordLine[0]).toContain('env="test"')
				expect(recordLine[0]).toContain('service="api"')
			}
		})

		it('escapes control characters in names and labels before writing to the terminal', async() => {
			const exporter = new ConsoleExporter({color: false})
			await exporter.export([{
				name: 'metric\n\u001b[31mspoofed',
				type: 'gauge',
				value: 1,
				labels: {'unsafe\nkey': 'value\n\u001b[2J'},
				timestamp: 1000
			}])

			const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join('\n')
			expect(output).not.toContain('\u001b[31m')
			expect(output).not.toContain('\u001b[2J')
			expect(output).toContain('metric\\n\\u001b[31mspoofed')
			expect(output).toContain('unsafe\\nkey="value\\n\\u001b[2J"')
		})

		it('should use color codes when color enabled', async() => {

			const exporter = new ConsoleExporter({color: true})
			const record: MetricRecord = {
				name: 'test_metric',
				type: 'counter',
				value: 1,
				labels: {},
				timestamp: 1000
			}

			await exporter.export([record])

			expect(consoleLogSpy).toHaveBeenCalled()
			const calls = consoleLogSpy.mock.calls
			// Check for ANSI color codes
			expect(calls[0]?.[0]).toContain('\x1b[36m') // Cyan for name
			expect(calls[1]?.[0]).toContain('\x1b[33m') // Yellow for value
		})

		it('should handle multiple metric types', async() => {

			const exporter = new ConsoleExporter({color: false})
			const records: MetricRecord[] = [
				{name: 'counter1', type: 'counter', value: 1, labels: {}, timestamp: 1000},
				{name: 'gauge1', type: 'gauge', value: 42.5, labels: {}, timestamp: 1000},
				{name: 'histogram1', type: 'histogram', value: 1.5, labels: {}, timestamp: 1000}
			]

			await exporter.export(records)

			expect(consoleLogSpy).toHaveBeenCalled()
		})
	})

	describe('flush', () => {

		it('should be a no-op', async() => {

			const exporter = new ConsoleExporter()

			await expect(exporter.flush()).resolves.not.toThrow()
		})
	})

	describe('shutdown', () => {

		it('should be a no-op', async() => {

			const exporter = new ConsoleExporter()

			await expect(exporter.shutdown()).resolves.not.toThrow()
		})
	})

	describe('createConsoleExporter', () => {

		it('should create console exporter', () => {

			const exporter = createConsoleExporter()

			expect(exporter).toBeInstanceOf(ConsoleExporter)
		})

		it('should create console exporter with options', () => {

			const exporter = createConsoleExporter({color: true})

			expect(exporter).toBeInstanceOf(ConsoleExporter)
		})
	})
})
