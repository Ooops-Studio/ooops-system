import type {EventsObservabilityEvent} from '@ooopsstudio/events/observability'
import type {JobsObservabilityEvent} from '@ooopsstudio/jobs/observability'
import type {PerformanceObservabilityEvent} from '@ooopsstudio/performance/observability'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const state = vi.hoisted(() => ({
	listeners: new Map<string, (event: never) => unknown>(),
	tracing: new Map<string, unknown>()
}))
vi.mock('@ooopsstudio/events/observability', () => ({attachEventsObservability: (_: unknown, listener: (event: never) => unknown, tracing: unknown) => { state.listeners.set('events', listener); state.tracing.set('events', tracing); return vi.fn() }}))
vi.mock('@ooopsstudio/jobs/observability', () => ({attachJobsObservability: (_: unknown, listener: (event: never) => unknown, tracing: unknown) => { state.listeners.set('jobs', listener); state.tracing.set('jobs', tracing); return vi.fn() }}))
vi.mock('@ooopsstudio/performance/observability', () => ({attachPerformanceObservability: (_: unknown, listener: (event: never) => unknown) => { state.listeners.set('performance', listener); return vi.fn() }}))

import {wireEventsObservability} from '../src/events'
import {wireJobsObservability} from '../src/jobs'
import {wirePerformanceObservability} from '../src/performance'

function output() {
	const increment = vi.fn(); const record = vi.fn(); const report = vi.fn()
	const info = vi.fn(); const warn = vi.fn(); const error = vi.fn(); const breadcrumb = vi.fn()
	const tracer = {
		injectHeaders: vi.fn(), inSpan: vi.fn(), withExtractedHeaders: vi.fn(),
		addBreadcrumb: breadcrumb,
		getActiveSpan: undefined as undefined
			| (() => {setAttribute(name: string, value: unknown): void})
	}
	return {increment, record, report, info, warn, error, breadcrumb, tracer, options: {
		metrics: {increment, record}, errors: {report},
		logger: {debug: vi.fn(), info, warn, error}, tracer
	}}
}

const emit = <T>(name: string, event: T): unknown => state.listeners.get(name)!(event as never)

const reportedText = (report: ReturnType<typeof output>['report']): string =>
	report.mock.calls
		.flatMap((call) => call)
		.map((value) => {
			if (value instanceof Error) return `${value.name}: ${value.message}`
			if (typeof value === 'string') return value
			if (value && typeof value === 'object') {
				return Object.entries(value as Record<string, unknown>)
					.map(([key, entry]) => `${key}=${String(entry)}`)
					.join(' ')
			}
			return String(value)
		})
		.join(' ')

beforeEach(() => { state.listeners.clear(); state.tracing.clear() })

describe('events, jobs, and performance bridges', () => {
	it('maps events and passes the tracing capability through unchanged', () => {
		const destination = output()
		wireEventsObservability({} as never, destination.options as never)
		emit<EventsObservabilityEvent>('events', {kind: 'published', result: 'success'})
		emit<EventsObservabilityEvent>('events', {kind: 'delivered', result: 'failure', transport: 'http'})
		emit<EventsObservabilityEvent>('events', {kind: 'consumed', result: 'duplicate'})
		emit<EventsObservabilityEvent>('events', {kind: 'retry'})
		emit<EventsObservabilityEvent>('events', {kind: 'active', value: 2})
		emit<EventsObservabilityEvent>('events', {kind: 'queue', size: 3})
		emit<EventsObservabilityEvent>('events', {kind: 'finalization-failure', operation: 'shutdown', error: new Error('secret')})
		emit<EventsObservabilityEvent>('events', {kind: 'delivered', result: 'success', transport: 'http'})
		expect(state.tracing.get('events')).toBe(destination.tracer)
		expect(destination.report).toHaveBeenCalledTimes(2)
		expect(reportedText(destination.report)).not.toContain('secret')
		expect(destination.info).toHaveBeenCalledWith('Events delivery recovered', {code: 'EVENTS_RECOVERED'})
	})

	it('maps every jobs event and sanitizes domain log attributes', () => {
		const destination = output()
		wireJobsObservability({} as never, destination.options as never)
		for (const event of [
			{kind: 'enqueued', result: 'success'}, {kind: 'execution', result: 'completed'},
			{kind: 'retry'}, {kind: 'active', count: 2}, {kind: 'rejected', reason: 'capacity'},
			{kind: 'operation_failed', operation: 'backend', code: 'JOBS_FAILED', error: new Error('backend secret'), reportable: true},
			{kind: 'finalization_failed', operation: 'shutdown', code: 'JOBS_FINALIZE'},
			{kind: 'log', level: 'warn', message: 'bounded', attributes: {safe: true, nested: {secret: 'x'}}},
			{kind: 'recovered'}
		] as JobsObservabilityEvent[]) emit('jobs', event)
		expect(state.tracing.get('jobs')).toBe(destination.tracer)
		expect(destination.warn).toHaveBeenCalledWith('bounded', {safe: true})
		expect(destination.report).toHaveBeenCalledTimes(2)
		expect(reportedText(destination.report)).not.toContain('backend secret')
		expect(destination.error).toHaveBeenCalledOnce()
	})

	it('maps performance events, resource snapshots, and active-span decoration', () => {
		const destination = output()
		const setAttribute = vi.fn()
		destination.options.tracer.getActiveSpan = () => ({setAttribute})
		wirePerformanceObservability({} as never, destination.options as never)
		emit<PerformanceObservabilityEvent>('performance', {kind: 'self_metric', name: '_performance_active_measurements', value: 2})
		emit<PerformanceObservabilityEvent>('performance', {kind: 'budget_violation', violation: {name: 'api', target: 50, actual: 70} as never})
		emit<PerformanceObservabilityEvent>('performance', {kind: 'n1_pattern', pattern: {type: 'duplicate-query', duplicateCount: 4, querySignature: 'bounded'} as never})
		emit<PerformanceObservabilityEvent>('performance', {kind: 'performance_event', event: {name: 'cpu_usage', duration: 1, source: 'runtime', labels: {utilization: 0.5, user: 1, system: 2}} as never})
		expect(destination.record).toHaveBeenCalledWith('_performance_active_measurements', 2, undefined)
		expect(destination.record).toHaveBeenCalledWith('process_cpu_utilization', 0.5)
		expect(setAttribute).toHaveBeenCalledWith('performance.measurement', expect.objectContaining({name: 'cpu_usage'}))
	})

	it('logs saturation transitions, bounded reminders, and recovery without informational noise', () => {
		const destination = output()
		wirePerformanceObservability({} as never, destination.options as never)
		emit<PerformanceObservabilityEvent>('performance', {
			kind: 'saturation_alert',
			alert: {reason: 'event_loop_lag', severity: 'info', value: 25, threshold: 20, state: 'info', previousState: 'healthy', aggregation: 'p95', sampleCount: 20}
		})
		emit<PerformanceObservabilityEvent>('performance', {
			kind: 'saturation_alert',
			alert: {reason: 'event_loop_lag', severity: 'warn', value: 60, threshold: 50, state: 'warn', previousState: 'info', aggregation: 'p95', sampleCount: 20}
		})
		emit<PerformanceObservabilityEvent>('performance', {
			kind: 'saturation_alert',
			alert: {reason: 'event_loop_lag', severity: 'critical', value: 120, threshold: 100, state: 'critical', previousState: 'warn', aggregation: 'p95', sampleCount: 30}
		})
		emit<PerformanceObservabilityEvent>('performance', {
			kind: 'saturation_alert',
			alert: {reason: 'event_loop_lag', severity: 'critical', value: 130, threshold: 100, state: 'critical', previousState: 'critical', reminder: true, aggregation: 'p95', sampleCount: 100}
		})
		emit<PerformanceObservabilityEvent>('performance', {
			kind: 'saturation_alert',
			alert: {reason: 'event_loop_lag', severity: 'info', value: 10, threshold: 20, state: 'healthy', previousState: 'critical', aggregation: 'p95', sampleCount: 100}
		})

		expect(destination.warn).toHaveBeenCalledTimes(3)
		expect(destination.warn).toHaveBeenNthCalledWith(1, 'Performance saturation state changed', expect.objectContaining({state: 'warn', previous_state: 'info'}))
		expect(destination.warn).toHaveBeenNthCalledWith(2, 'Performance saturation state changed', expect.objectContaining({state: 'critical', previous_state: 'warn'}))
		expect(destination.warn).toHaveBeenNthCalledWith(3, 'Performance saturation persists', expect.objectContaining({state: 'critical'}))
		expect(destination.info).toHaveBeenCalledOnce()
		expect(destination.info).toHaveBeenCalledWith('Performance saturation recovered', expect.objectContaining({state: 'healthy', previous_state: 'critical'}))
	})
})
