import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {MetricsStatusSnapshot} from './instruments'

/** Runtime shape before projection to the public managed facade. */
export interface MetricsHandlerPort extends Required<MetricsPort> {
	counter(name: string, count?: number, labels?: Record<string, string>): void
	upDownCounter(name: string, delta: number, labels?: Record<string, string>): void
	gauge(name: string, value: number, labels?: Record<string, string>): void
	histogram(name: string, value: number, labels?: Record<string, string>): void
	timer(name: string, durationMs: number, labels?: Record<string, string>): void
	flush(): Promise<void>
	shutdown(): Promise<void>
	getStatus(): MetricsStatusSnapshot
}
