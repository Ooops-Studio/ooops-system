import type {
	ManagedMetrics,
	MetricsStatus,
	PrometheusManagedMetrics
} from '../public/types'
import type {PrometheusScrape} from '../sinks/prometheus'
import type {MetricsHandlerPort} from '../types/ports'
import type {PrometheusScrapeCapability} from '../utils/prometheus-scrape-capability'

function safeStatus(handler: MetricsHandlerPort): MetricsStatus {
	try {
		const status = handler.getStatus?.()
		if (!status) throw new Error('Metrics status is unavailable')
		return Object.freeze({
			state: status.state,
			queueSize: Math.max(0, status.queueSize),
			activeSeries: Math.max(0, status.activeSeries),
			droppedTotal: Math.max(0, status.droppedTotal),
			retriedTotal: Math.max(0, status.retriedTotal),
			sinkState: status.sinkState,
			...(status.lastFailureCode && status.sinkState !== 'healthy'
				? {lastFailureCode: status.lastFailureCode} : {})
		})
	} catch {
		return Object.freeze({
			state: 'draining',
			queueSize: 0,
			activeSeries: 0,
			droppedTotal: 0,
			retriedTotal: 0,
			sinkState: 'unhealthy',
			lastFailureCode: 'METRICS_STATUS_FAILURE'
		})
	}
}

/**
 * Project the internal runtime to the deliberately small public contract.
 * Keeping this as an own-property facade also prevents accidental API growth.
 */
export function createManagedMetricsFacade(handler: MetricsHandlerPort): ManagedMetrics {
	if (!handler.increment || !handler.record || !handler.counter || !handler.upDownCounter
		|| !handler.gauge || !handler.histogram || !handler.timer
		|| !handler.flush || !handler.shutdown) {
		throw new Error('Metrics runtime does not implement the managed contract')
	}
	const increment = handler.increment.bind(handler)
	const record = handler.record.bind(handler)
	const counter = handler.counter.bind(handler)
	const upDownCounter = handler.upDownCounter.bind(handler)
	const gauge = handler.gauge.bind(handler)
	const histogram = handler.histogram.bind(handler)
	const timer = handler.timer.bind(handler)
	const flush = handler.flush.bind(handler)
	const shutdown = handler.shutdown.bind(handler)
	return Object.freeze({
		increment,
		record,
		counter,
		upDownCounter,
		gauge,
		histogram,
		timer,
		getStatus: () => safeStatus(handler),
		flush,
		shutdown
	})
}

export function createPrometheusManagedMetricsFacade(
	handler: MetricsHandlerPort,
	scrape: PrometheusScrapeCapability
): PrometheusManagedMetrics {
	const managed = createManagedMetricsFacade(handler)
	return Object.freeze({
		...managed,
		getPrometheusScrape: (format?: 'openmetrics' | 'prometheus'): PrometheusScrape => scrape(format)
	})
}
