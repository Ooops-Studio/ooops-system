import type {MetricExporterPort} from '../../src/types/exporter'
import type {MetricRecord} from '../../src/types/metric-record'

function cloneRecord(record: MetricRecord): MetricRecord {
	return {
		...record,
		labels: {...record.labels},
		...(record.metadata ? {metadata: {...record.metadata}} : {}),
		...(record.exemplar ? {exemplar: {...record.exemplar}} : {})
	}
}

/** Test fixture only. It is deliberately not part of the published metrics runtime. */
export class RecordingMetricsExporter implements MetricExporterPort {
	private readonly records: MetricRecord[] = []

	async export(batch: ReadonlyArray<MetricRecord>): Promise<void> {
		this.records.push(...batch.map(cloneRecord))
	}

	async flush(): Promise<void> {}
	async shutdown(): Promise<void> {}

	getMetrics(): ReadonlyArray<MetricRecord> {
		return this.records.map(cloneRecord)
	}

	getMetricsByName(name: string): ReadonlyArray<MetricRecord> {
		return this.records.filter((record) => record.name === name).map(cloneRecord)
	}

	clear(): void {
		this.records.length = 0
	}
}

export function createRecordingMetricsExporter(): RecordingMetricsExporter {
	return new RecordingMetricsExporter()
}
