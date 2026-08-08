import type {LifecycleDegradationSeverity, LifecycleStartupStage} from '@ooopsstudio/core/contracts/lifecycle'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import {normalizeError} from '@ooopsstudio/core/utils/error/normalize-error'

import type {LifecycleObservabilityOptions} from '../types/lifecycle'

type TelemetryKey = 'errors' | 'logger' | 'metrics' | 'tracer'
export type TelemetryPorts = Pick<LifecycleObservabilityOptions, TelemetryKey>

const controllers = new WeakMap<object, LifecycleTelemetryController>()

function safe(action: () => void): void {
	try { action() } catch { /* observability never changes lifecycle */ }
}

export class LifecycleTelemetryController {
	private errors: Errors | undefined
	private logger: Logging | undefined
	private metrics: MetricsPort | undefined
	private tracer: Tracing | undefined
	private readonly selfMetrics: boolean
	private readonly cleanups = new Set<() => void>()

	constructor(options: LifecycleObservabilityOptions = {}) {
		this.errors = options.errors
		this.logger = options.logger
		this.metrics = options.metrics
		this.tracer = options.tracer
		this.selfMetrics = options.selfMetrics !== false
	}

	private getPort(key: TelemetryKey): Errors | Logging | MetricsPort | Tracing | undefined {
		switch (key) {
			case 'errors': return this.errors
			case 'logger': return this.logger
			case 'metrics': return this.metrics
			case 'tracer': return this.tracer
		}
	}

	private setPort(
		key: TelemetryKey,
		value: Errors | Logging | MetricsPort | Tracing | undefined
	): void {
		switch (key) {
			case 'errors': this.errors = value as Errors | undefined; break
			case 'logger': this.logger = value as Logging | undefined; break
			case 'metrics': this.metrics = value as MetricsPort | undefined; break
			case 'tracer': this.tracer = value as Tracing | undefined; break
		}
	}

	attach(options: TelemetryPorts): () => void {
		for (const key of ['errors', 'logger', 'metrics', 'tracer'] as const) {
			const incoming = options[key]
			if (incoming === undefined) continue
			const current = this.getPort(key)
			if (current !== undefined && current !== incoming) {
				throw new Error(`Lifecycle telemetry ${key} is already attached`)
			}
		}
		const attached: Partial<TelemetryPorts> = {}
		for (const key of ['errors', 'logger', 'metrics', 'tracer'] as const) {
			const incoming = options[key]
			if (incoming === undefined) continue
			const current = this.getPort(key)
			if (current !== undefined) continue
			this.setPort(key, incoming)
			;(attached as Record<TelemetryKey, unknown>)[key] = incoming
		}
		let active = true
		return () => {
			if (!active) return
			active = false
			for (const key of Object.keys(attached) as TelemetryKey[]) {
				if (this.getPort(key) === attached[key]) this.setPort(key, undefined)
			}
		}
	}

	attachCleanup(cleanup: () => void): () => void {
		this.cleanups.add(cleanup)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.cleanups.delete(cleanup)
		}
	}

	dispose(): void {
		const pending = [...this.cleanups]
		this.cleanups.clear()
		for (const cleanup of pending) safe(cleanup)
	}

	startup(result: 'success' | 'failure', durationMs: number): void {
		if (this.selfMetrics) {
			safe(() => this.metrics?.increment?.('_lifecycle_startups_total', {result}))
			safe(() => this.metrics?.record?.('_lifecycle_startup_duration_ms', durationMs))
		}
		safe(() => this.logger?.[result === 'success' ? 'info' : 'error'](
			`lifecycle.startup_${result}`, {result, durationMs}
		))
		this.trace(`lifecycle.startup.${result}`, {'lifecycle.duration_ms': durationMs}, result === 'failure')
		if (result === 'failure') this.report('Lifecycle startup failed', 'LIFECYCLE_STARTUP_FAILURE')
	}

	shutdown(result: 'success' | 'failure' | 'timeout', durationMs: number): void {
		if (this.selfMetrics) {
			safe(() => this.metrics?.increment?.('_lifecycle_shutdowns_total', {result}))
			safe(() => this.metrics?.record?.('_lifecycle_shutdown_duration_ms', durationMs))
		}
		safe(() => this.logger?.[result === 'success' ? 'info' : 'error'](
			`lifecycle.shutdown_${result}`, {result, durationMs}
		))
		this.trace(`lifecycle.shutdown.${result}`, {'lifecycle.duration_ms': durationMs}, result !== 'success')
		if (result !== 'success') this.report('Lifecycle shutdown failed', result === 'timeout'
			? 'LIFECYCLE_SHUTDOWN_TIMEOUT'
			: 'LIFECYCLE_SHUTDOWN_FAILURE')
	}

	hookFailure(stage: LifecycleStartupStage | 'shutdown' | 'flush'): void {
		if (this.selfMetrics) safe(() => this.metrics?.increment?.('_lifecycle_hook_failures_total', {stage}))
		safe(() => this.logger?.warn('lifecycle.hook_failure', {stage, code: 'LIFECYCLE_HOOK_FAILURE'}))
		this.report('Lifecycle hook failed', 'LIFECYCLE_HOOK_FAILURE', {stage})
	}

	healthFailure(criticality: 'required' | 'optional'): void {
		if (this.selfMetrics) {
			safe(() => this.metrics?.increment?.('_lifecycle_health_check_failures_total', {criticality}))
		}
	}

	degradation(severity: LifecycleDegradationSeverity): void {
		if (this.selfMetrics) safe(() => this.metrics?.increment?.('_lifecycle_degradations_total', {severity}))
		safe(() => this.logger?.warn('lifecycle.degraded', {severity}))
	}

	private report(message: string, code: string, context: Record<string, string> = {}): void {
		const error = normalizeError(Object.assign(new Error(message), {name: code}))
		safe(() => this.errors?.report(error, {
			source: 'lifecycle', code, ...context
		}))
	}

	private trace(name: string, attributes: Record<string, string | number>, failed: boolean): void {
		safe(() => {
			const span = this.tracer?.startSpan(name, {kind: 'internal', attributes})
			if (!span) return
			try { span.setStatus({code: failed ? 'error' : 'ok'}) } finally { span.end() }
		})
	}
}

export function registerLifecycleTelemetry(
	runtime: object,
	controller: LifecycleTelemetryController
): void {
	controllers.set(runtime, controller)
}

export function unregisterLifecycleTelemetry(runtime: object): void {
	controllers.delete(runtime)
}

export function attachLifecycleTelemetry(runtime: object, options: TelemetryPorts): () => void {
	const controller = controllers.get(runtime)
	if (!controller) throw new Error('Lifecycle observability requires a managed lifecycle runtime')
	return controller.attach(options)
}
