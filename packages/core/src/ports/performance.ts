import type {
	DBQueryMetadata,
	HttpPerfMetadata,
	PerformanceEventRecord,
	PerformanceSpanOptions
} from '../contracts/performance'

export interface PerformanceEventExporterPort {
	export(records: ReadonlyArray<PerformanceEventRecord>): Promise<void> | void
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

export interface PerformancePort {
	measureAsync?<T>(name: string, fn: () => Promise<T>, labels?: Readonly<Record<string, string>>): Promise<T>
	measureDBQuery?<T>(
		name: string,
		fn: () => Promise<T>,
		metadata?: DBQueryMetadata,
		labels?: Readonly<Record<string, string>>
	): Promise<T>
	measureDBQuerySync?<T>(
		name: string,
		fn: () => T,
		metadata?: DBQueryMetadata,
		labels?: Readonly<Record<string, string>>
	): T
	measureRequest?<T>(
		name: string,
		fn: () => Promise<T>,
		metadata: HttpPerfMetadata,
		labels?: Readonly<Record<string, string>>
	): Promise<T>
	measureSpan?<T>(name: string, fn: () => Promise<T>, options?: PerformanceSpanOptions): Promise<T>
	record?(metric: string, value: number, labels?: Readonly<Record<string, string>>): void
	measureSync?<T>(name: string, fn: () => T, labels?: Readonly<Record<string, string>>): T
}
