export interface BatchingConfig {
	maxBatch: number
	maxIntervalMs: number
	maxBytes: number
}

export interface ProcessorObserver {
	onExported?(count: number): void
	/** `metricsReported` avoids counting batch-processor drops twice. */
	onDropped?(count: number, error?: unknown, metricsReported?: boolean): void
	onExportFailure?(error: unknown): void
	onPartialDelivery?(error: unknown): void
	onRetry?(): void
	onSinkState?(state: 'healthy' | 'degraded' | 'unhealthy'): void
}

/** Internal-only delivery hook. It is deliberately absent from the public exporter contract. */
export interface DeliveryObservableExporter {
	setDeliveryObserver(observer: Pick<ProcessorObserver, 'onRetry' | 'onSinkState'>): void
}
