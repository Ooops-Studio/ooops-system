/**
 * @file Console exporter implementation.
 * Pretty-prints metrics for development with color-coded output.
 */

import type {MetricExporterPort} from '../../types/exporter'
import type {MetricRecord} from '../../types/metric-record'
import {snapshotMetricBatch} from '../../utils/metric-record-snapshot'

/**
 * Options for console exporter
 */
export interface ConsoleExporterOptions {
	readonly color?: boolean
}

function escapeConsoleText(value: string): string {
	return JSON.stringify(value).slice(1, -1)
}

/**
 * Console exporter
 * Pretty-prints metrics for development
 */
export class ConsoleExporter implements MetricExporterPort {

	private readonly color: boolean

	constructor(options: ConsoleExporterOptions = {}) {
		if (!options || typeof options !== 'object' || Array.isArray(options)) {
			throw new Error('Console exporter options must be an object')
		}
		let prototype: object | null
		let descriptors: PropertyDescriptorMap
		let symbols: symbol[]
		try {
			prototype = Object.getPrototypeOf(options)
			descriptors = Object.getOwnPropertyDescriptors(options)
			symbols = Object.getOwnPropertySymbols(options)
		} catch {
			throw new Error('Console exporter options must expose stable known data fields')
		}
		if ((prototype !== Object.prototype && prototype !== null) || symbols.length > 0
			|| Object.entries(descriptors).some(([key, descriptor]) => key !== 'color'
				|| !descriptor.enumerable || !('value' in descriptor))) {
			throw new Error('Console exporter options must expose stable known data fields')
		}
		const color = descriptors.color?.value as unknown
		if (color !== undefined && typeof color !== 'boolean') {
			throw new Error('Console exporter color must be a boolean')
		}
		this.color = color ?? (typeof process !== 'undefined' && process.stdout?.isTTY)
	}

	async export(batch: ReadonlyArray<MetricRecord>): Promise<void> {
		const stableBatch = snapshotMetricBatch(batch)
		if (stableBatch.length === 0) {
			return
		}

		// Group by metric name
		const grouped = new Map<string, MetricRecord[]>()

		for (const record of stableBatch) {
			const existing = grouped.get(record.name) ?? []
			existing.push(record)
			grouped.set(record.name, existing)
		}

		// Print grouped metrics
		for (const [name, records] of grouped.entries()) {

			const nameColor = this.color ? '\x1b[36m' : '' // Cyan
			const resetColor = this.color ? '\x1b[0m' : ''

			console.log(`${nameColor}${escapeConsoleText(name)}${resetColor}`)

			for (const record of records) {

				const labelsStr = Object.entries(record.labels)
					.map(([k, v]) => `${escapeConsoleText(k)}=${JSON.stringify(v)}`)
					.join(', ')

				const valueColor = this.color ? '\x1b[33m' : '' // Yellow
				const typeColor = this.color ? '\x1b[90m' : '' // Gray

				console.log(
					`  ${typeColor}${record.type}${resetColor} ${valueColor}${record.value}${resetColor}${labelsStr ? ` {${labelsStr}}` : ''}`
				)
			}
		}
	}

	async flush(): Promise<void> {
		// No-op (stateless)
	}

	async shutdown(): Promise<void> {
		// No-op
	}
}

/**
 * Create a console exporter
 */
export function createConsoleExporter(options?: ConsoleExporterOptions): ConsoleExporter {
	return new ConsoleExporter(options)
}
