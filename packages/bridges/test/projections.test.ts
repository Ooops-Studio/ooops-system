import type {AuditObservabilityEvent} from '@ooopsstudio/audit/observability'
import type {CacheObservabilityEvent} from '@ooopsstudio/cache/observability'
import type {ProfilingObservabilityEvent} from '@ooopsstudio/profiling/observability'
import type {RateLimitObservabilityEvent} from '@ooopsstudio/rate-limit/observability'
import type {ResilienceObservabilityEvent} from '@ooopsstudio/resilience/observability'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const listeners = vi.hoisted(() => new Map<string, (event: never) => unknown>())
vi.mock('@ooopsstudio/audit/observability', () => ({attachAuditObservability: (_: unknown, listener: (event: never) => unknown) => { listeners.set('audit', listener); return vi.fn() }}))
vi.mock('@ooopsstudio/cache/observability', () => ({attachCacheObservability: (_: unknown, listener: (event: never) => unknown) => { listeners.set('cache', listener); return vi.fn() }}))
vi.mock('@ooopsstudio/profiling/observability', () => ({attachProfilingObservability: (_: unknown, listener: (event: never) => unknown) => { listeners.set('profiling', listener); return vi.fn() }}))
vi.mock('@ooopsstudio/rate-limit/observability', () => ({attachRateLimitObservability: (_: unknown, listener: (event: never) => unknown) => { listeners.set('rate-limit', listener); return vi.fn() }}))
vi.mock('@ooopsstudio/resilience/observability', () => ({attachResilienceObservability: (_: unknown, listener: (event: never) => unknown) => { listeners.set('resilience', listener); return vi.fn() }}))

import {wireAuditObservability} from '../src/audit'
import {wireCacheObservability} from '../src/cache'
import {wireProfilingObservability} from '../src/profiling'
import {wireRateLimitObservability} from '../src/rate-limit'
import {wireResilienceObservability} from '../src/resilience'

function destinations() {
	return {
		increment: vi.fn(), record: vi.fn(), report: vi.fn(),
		info: vi.fn(), error: vi.fn(), breadcrumb: vi.fn(),
		options() {
			return {
				metrics: {increment: this.increment, record: this.record}, errors: {report: this.report},
				logger: {info: this.info, error: this.error}, tracer: {addBreadcrumb: this.breadcrumb}
			} as never
		}
	}
}

function emit<T>(name: string, event: T): void { void listeners.get(name)!(event as never) }

beforeEach(() => { listeners.clear() })

describe('raw observability projections', () => {
	it('maps audit events and reports one failure transition', () => {
		const output = destinations()
		wireAuditObservability({} as never, output.options())
		emit<AuditObservabilityEvent>('audit', {kind: 'active', count: 2})
		emit<AuditObservabilityEvent>('audit', {kind: 'recorded', count: 3})
		emit<AuditObservabilityEvent>('audit', {kind: 'operation_failed', operation: 'record', code: 'AUDIT_FAILED', reportable: true})
		emit<AuditObservabilityEvent>('audit', {kind: 'operation_failed', operation: 'query', code: 'AUDIT_FAILED', reportable: false})
		emit<AuditObservabilityEvent>('audit', {kind: 'integrity_failed'})
		emit<AuditObservabilityEvent>('audit', {kind: 'pruned', count: 4})
		emit<AuditObservabilityEvent>('audit', {kind: 'finalization_failed', operation: 'shutdown', code: 'AUDIT_FINALIZE'})
		emit<AuditObservabilityEvent>('audit', {kind: 'recovered'})
		expect(output.record).toHaveBeenCalledWith('_audit_active_operations', 2)
		expect(output.increment).toHaveBeenCalledWith('_audit_records_total', {result: 'success'}, 3)
		expect(output.error).toHaveBeenCalledOnce()
		expect(output.info).toHaveBeenCalledOnce()
		expect(output.report).toHaveBeenCalledTimes(2)
	})

	it('maps every cache event and suppresses duplicate outage reports', () => {
		const output = destinations()
		wireCacheObservability({} as never, output.options())
		emit<CacheObservabilityEvent>('cache', {kind: 'operation', operation: 'get', result: 'success'})
		emit<CacheObservabilityEvent>('cache', {kind: 'lookup', result: 'fresh'})
		emit<CacheObservabilityEvent>('cache', {kind: 'dropped', reason: 'capacity'})
		emit<CacheObservabilityEvent>('cache', {kind: 'active_operations', count: 1})
		emit<CacheObservabilityEvent>('cache', {kind: 'active_loads', count: 2})
		emit<CacheObservabilityEvent>('cache', {kind: 'backend_failed', operation: 'read', code: 'CACHE_FAILED'})
		emit<CacheObservabilityEvent>('cache', {kind: 'finalization_failed', operation: 'shutdown', code: 'CACHE_FINALIZE'})
		emit<CacheObservabilityEvent>('cache', {kind: 'recovered'})
		expect(output.error).toHaveBeenCalledOnce()
		expect(output.report).toHaveBeenCalledOnce()
		expect(output.info).toHaveBeenCalledOnce()
	})

	it('preserves the profiling metric families outside the profiling package', () => {
		const output = destinations()
		wireProfilingObservability({} as never, output.options())
		for (const event of [
			{kind: 'capture_started'}, {kind: 'capture_completed'}, {kind: 'dropped', reason: 'busy'},
			{kind: 'capture_failed', reason: 'capture_failed'}, {kind: 'export_failed', count: 2},
			{kind: 'continuous_failed', operation: 'start'}, {kind: 'finalization_failed', operation: 'shutdown'},
			{kind: 'recovered'}
		] as ProfilingObservabilityEvent[]) emit('profiling', event)
		const calls = [...output.increment.mock.calls, ...output.record.mock.calls]
		const names = new Set(calls.map(([name]) => name))
		expect(names).toEqual(new Set(['_profiling_active_capture', '_profiling_captures_total', '_profiling_dropped_total',
			'_profiling_export_failures_total', '_profiling_continuous_failures_total', '_profiling_finalization_failures_total']))
		expect(output.error).toHaveBeenCalledOnce()
		expect(output.info).toHaveBeenCalledOnce()
	})

	it('maps rate-limit and resilience without high-cardinality labels', () => {
		const rate = destinations(); wireRateLimitObservability({} as never, rate.options())
		emit<RateLimitObservabilityEvent>('rate-limit', {kind: 'check', result: 'allowed'})
		emit<RateLimitObservabilityEvent>('rate-limit', {kind: 'rejection', reason: 'limit'})
		emit<RateLimitObservabilityEvent>('rate-limit', {kind: 'active_operations', count: 2})
		emit<RateLimitObservabilityEvent>('rate-limit', {kind: 'backend_failed', code: 'RATE_FAILED'})
		emit<RateLimitObservabilityEvent>('rate-limit', {kind: 'recovered'})
		expect(rate.increment).toHaveBeenCalledWith('_rate_limit_rejections_total', {reason: 'limit'})

		const resilience = destinations()
		wireResilienceObservability({} as never, resilience.options())
		for (const event of [
			{kind: 'active_operations', count: 1}, {kind: 'queued_operations', count: 2},
			{kind: 'execution', result: 'success'}, {kind: 'retry', attempt: 4},
			{kind: 'rejection', reason: 'breaker_open'},
			{kind: 'finalization_failed', operation: 'shutdown', code: 'RESILIENCE_FINALIZATION_FAILURE'}
		] as ResilienceObservabilityEvent[]) emit('resilience', event)
		expect(resilience.increment).toHaveBeenCalledWith('_resilience_retries_total')
		expect(resilience.increment).toHaveBeenCalledWith('_resilience_rejections_total', {reason: 'breaker_open'})
		expect(resilience.report).toHaveBeenCalledOnce()
	})
})
