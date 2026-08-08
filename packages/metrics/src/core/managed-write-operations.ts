import {METRIC_SELF_RECORDED_TOTAL} from '../constants'
import type {MetricsHandlerPort} from '../types/ports'

import type {MetricRecorder} from './recorder'

type WriteOperations = Pick<MetricsHandlerPort,
	'increment' | 'record' | 'counter' | 'upDownCounter' | 'gauge' | 'histogram' | 'timer'>

export function createManagedWriteOperations(options: {
	readonly recorder: MetricRecorder
	readonly selfRecorder?: MetricRecorder
	readonly acceptsWrites: () => boolean
	readonly onAccepted?: () => void
}): WriteOperations {
	const {recorder, selfRecorder, acceptsWrites, onAccepted} = options
	const recorded = (instrument: string): void => {
		onAccepted?.()
		try {
			selfRecorder?.counter(METRIC_SELF_RECORDED_TOTAL, 1, {instrument})
		} catch {
			// Self-metrics are observational and must never replace an accepted write.
		}
	}
	return {
		counter: (name, count = 1, labels) => {
			if (!acceptsWrites()) return
			recorder.counter(name, count, labels)
			recorded('counter')
		},
		upDownCounter: (name, delta, labels) => {
			if (!acceptsWrites()) return
			recorder.upDownCounter(name, delta, labels)
			recorded('up_down_counter')
		},
		gauge: (name, value, labels) => {
			if (!acceptsWrites()) return
			recorder.gauge(name, value, labels)
			recorded('gauge')
		},
		histogram: (name, value, labels) => {
			if (!acceptsWrites()) return
			recorder.histogram(name, value, labels)
			recorded('histogram')
		},
		timer: (name, durationMs, labels) => {
			if (!acceptsWrites()) return
			recorder.timer(name, durationMs, labels)
			recorded('timer')
		},
		increment: (name, labels, count = 1) => {
			if (!acceptsWrites()) return
			recorder.increment(name, labels, count)
			recorded('counter')
		},
		record: (name, value, labels) => {
			if (!acceptsWrites()) return
			recorder.record(name, value, labels)
			recorded('gauge')
		}
	}
}
