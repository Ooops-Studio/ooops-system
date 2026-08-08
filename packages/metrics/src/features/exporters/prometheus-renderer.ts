import type {MetricRecord} from '../../types/metric-record'
import {sanitizeLabelName, sanitizeMetricName} from '../../utils/label-sanitizer'

import {isPrometheusExemplarSample} from './prometheus-sample-utils'

export interface PrometheusRenderFamily {
	readonly name: string
	readonly type: string
	readonly metadata?: MetricRecord['metadata']
}

export interface PreparedPrometheusRender {
	readonly records: ReadonlyArray<MetricRecord>
	readonly families: ReadonlyArray<PrometheusRenderFamily>
}

export type PrometheusPreparation = (batch: ReadonlyArray<MetricRecord>) => PreparedPrometheusRender

function escapeLabelValue(value: string): string {
	return replaceUnsupportedControls(value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n'))
}

function escapeHelpText(value: string): string {
	return replaceUnsupportedControls(value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n'))
}

function replaceUnsupportedControls(value: string): string {
	return Array.from(value, (character) => {
		const code = character.codePointAt(0) ?? 0
		return code < 32 || code === 127 ? ' ' : character
	}).join('')
}

function formatNumber(value: number): string {
	if (Number.isNaN(value)) return 'NaN'
	if (value === Number.POSITIVE_INFINITY) return '+Inf'
	if (value === Number.NEGATIVE_INFINITY) return '-Inf'
	return String(value)
}

export function formatPrometheusMetricLine(
	record: MetricRecord,
	format: 'openmetrics' | 'prometheus'
): string {
	const labelPairs = Object.entries(record.labels).map(([key, value]) => `${sanitizeLabelName(key)}="${escapeLabelValue(value)}"`)
	let line = `${sanitizeMetricName(record.name)}${labelPairs.length ? `{${labelPairs.join(',')}}` : ''} ${formatNumber(record.value)}`
	if (Number.isFinite(record.timestamp)) {
		line += ` ${format === 'openmetrics'
			? formatNumber(record.timestamp / 1000)
			: Math.trunc(record.timestamp)}`
	}
	if (format === 'openmetrics' && isPrometheusExemplarSample(record)
		&& record.exemplar && Number.isFinite(record.exemplar.timestamp)) {
		const labels = [
			record.exemplar.traceId ? `trace_id="${escapeLabelValue(record.exemplar.traceId)}"` : undefined,
			record.exemplar.spanId ? `span_id="${escapeLabelValue(record.exemplar.spanId)}"` : undefined
		].filter((label): label is string => label !== undefined)
		if (labels.length) line += ` # {${labels.join(',')}} ${formatNumber(record.exemplar.value)} ${record.exemplar.timestamp / 1000}`
	}
	return line
}

export function renderPrometheus(
	batch: ReadonlyArray<MetricRecord>,
	format: 'openmetrics' | 'prometheus',
	prepare: PrometheusPreparation
): string {
	if (batch.length === 0) return format[0] === 'o' ? '# EOF\n' : ''
	const {records, families} = prepare(batch)
	if (format === 'prometheus') return `${records.map((record) => formatPrometheusMetricLine(record, format)).join('\n')}\n`
	const recordsByFamily = new Map<string, MetricRecord[]>(
		families.map((family) => [family.name, []])
	)
	for (const record of records) {
		const composite = record.metadata?.instrument === 'histogram'
			|| record.metadata?.instrument === 'timer'
		const owner = composite
			? record.name.replace(/_(bucket|sum|count)$/u, '')
			: record.type === 'counter' && record.name.endsWith('_total')
				? record.name.slice(0, -'_total'.length) : record.name
		const output = recordsByFamily.get(owner)
		if (!output) {
			throw new Error(`Invalid OpenMetrics family: ${record.name}`)
		}
		output.push(record)
	}
	const lines: string[] = []
	for (const family of families) {
		const description = family.metadata?.description ?? `${family.name} metric`
		const unit = family.metadata?.unit
		lines.push(`# TYPE ${family.name} ${family.type}`)
		lines.push(`# HELP ${family.name} ${escapeHelpText(unit ? `${description} (unit: ${unit})` : description)}`)
		for (const record of recordsByFamily.get(family.name) ?? []) {
			lines.push(formatPrometheusMetricLine(record, format))
		}
	}
	lines.push('# EOF')
	return `${lines.join('\n')}\n`
}
