import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

import * as metrics from '../src'
import * as custom from '../src/public/custom'
import * as development from '../src/public/development'
import * as production from '../src/public/production'
import * as otlpProduction from '../src/public/production-otlp'
import * as prometheusProduction from '../src/public/production-prometheus'
import * as sinks from '../src/sinks'

describe('metrics package exports', () => {
	it('publishes only managed preset, provider and adapter subpaths', () => {
		const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
			exports: Record<string, unknown>
		}
		const keys = Object.keys(manifest.exports).sort()
		expect(keys).toEqual([
			'.', './custom', './development', './production', './production/otlp', './production/prometheus',
			'./public/types', './sinks', './sinks/otlp', './sinks/prometheus', './sinks/prometheus-http'
		].sort())
		expect(manifest.exports).not.toHaveProperty('./minimal')
		expect(manifest.exports).not.toHaveProperty('./testing')
	})

	it('does not expose removed runtime controls or stage internals', () => {
		expect(Object.keys(metrics)).toEqual(['registerMetrics'])
		expect(Object.keys(development)).toEqual(['createDevelopmentMetrics'])
		expect(Object.keys(production)).toEqual(['createProductionMetrics'])
		expect(Object.keys(prometheusProduction)).toEqual(['createPrometheusMetrics'])
		expect(Object.keys(otlpProduction)).toEqual(['createOtlpMetrics'])
		expect(Object.keys(custom)).toEqual(['createCustomMetrics'])
		expect(Object.keys(sinks)).toEqual(['createMetricsSink'])
		for (const module of [metrics, development, production, custom, sinks]) {
			expect(module).not.toHaveProperty('resolveMetricsSink')
			expect(module).not.toHaveProperty('createDegradePolicy')
			expect(module).not.toHaveProperty('MetricsBufferWrapper')
		}
	})

	it('keeps the internal handler status restricted to the managed status fields', () => {
		const declarations = readFileSync(new URL('../src/types/instruments.ts', import.meta.url), 'utf8')
		for (const removed of [
			'ExporterHealthSnapshot', 'CardinalityMetricSnapshot', 'lastError',
			'registeredMetrics', 'queuedExports', 'buffer:', 'exporters:', 'cardinality:'
		]) expect(declarations).not.toContain(removed)
	})
})
