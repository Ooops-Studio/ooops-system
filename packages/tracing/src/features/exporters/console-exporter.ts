/**
 * @file Console exporter for tracing spans.
 * Pretty-prints spans for development.
 */
import {types as utilTypes} from 'node:util'

import type {SpanRecord} from '@ooopsstudio/core/contracts/tracing'

import {pushNativeArray} from '../../core/native-runtime'
import {estimateSpanSize, snapshotSpanRecord} from '../../core/processor-utils'
import type {SpanExporterPort} from '../../types/ports'
import {snapshotDataFields} from '../../utils/capabilities'
/**
 * Options for console exporter.
 */
export interface ConsoleExporterOptions {
	/** Enable color output */
	color?: boolean
}
/**
 * Console exporter: prints spans to console.
 */
export class ConsoleExporter implements SpanExporterPort {
	private readonly color: boolean
	constructor(options: ConsoleExporterOptions = {}) {
		let configured: Readonly<Record<string, unknown>>
		try { configured = snapshotDataFields(options, 1, 32, new Set(['color'])) }
		catch { throw new TypeError('Tracing console exporter options must be a closed plain data object') }
		if (configured.color !== undefined && typeof configured.color !== 'boolean') {
			throw new TypeError('Tracing console exporter color must be a boolean')
		}
		this.color = (configured.color as boolean | undefined) ?? (typeof process !== 'undefined' && process.stdout?.isTTY)
	}
	async export(spans: readonly SpanRecord[]) {
		const safeSpans = snapshotConsoleBatch(spans)
		if (!safeSpans) return {
			status: 'permanent-failure' as const,
			acceptedCount: 0,
			error: new Error('Tracing console export input is unsafe')
		}
		if (safeSpans.length === 0) {
			return {
				status: 'success' as const,
				acceptedCount: 0
			}
		}
		for (let index = 0; index < safeSpans.length; index++) {
			const span = safeSpans[index]!
			const nameColor = this.color ? '\x1b[36m' : ''
			/* v8 ignore next -- defensive branch not constructible through the public tracing API */
			const statusCode = span.status?.code ?? 'unset'
			const statusColor = this.color
				? (statusCode === 'error'
					? '\x1b[31m'
					: statusCode === 'ok'
						? '\x1b[32m'
						: '\x1b[33m')
				: ''
			const resetColor = this.color ? '\x1b[0m' : ''
			const duration = span.durationMs !== undefined ? `${span.durationMs}ms` : '?'
			const traceId = span.context.traceId.substring(0, 16) + '...'
			const spanId = span.context.spanId.substring(0, 8) + '...'
			console.log(
				`${nameColor}span ${span.name}${resetColor} ${statusColor}${statusCode}${resetColor} ${duration} trace=${traceId} span=${spanId}`
			)
		}
		return {
			status: 'success' as const,
			acceptedCount: safeSpans.length
		}
	}
	async shutdown(): Promise<void> {
		// No-op
	}
}

function snapshotConsoleBatch(value: unknown): SpanRecord[] | undefined {
	try {
		if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || !Array.isArray(value)) return undefined
		const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown
		if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 10_000) return undefined
		const result: SpanRecord[] = []
		let bytes = 0
		for (let index = 0; index < (length as number); index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
			const span = snapshotSpanRecord(descriptor.value as SpanRecord)
			if (!span) return undefined
			const size = estimateSpanSize(span)
			if (!Number.isFinite(size) || bytes + size > 16 * 1_024 * 1_024) return undefined
			bytes += size
			pushNativeArray(result, span)
		}
		return result
	} catch { return undefined }
}
/**
 * Create a console exporter.
 */
export function createConsoleExporter(options?: ConsoleExporterOptions): ConsoleExporter {
	return new ConsoleExporter(options)
}
