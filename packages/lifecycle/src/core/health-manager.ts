import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {
	LifecycleDegradationSeverity,
	LifecycleHealthCheckDefinition,
	LifecycleHealthCheckResult,
	LifecycleHealthCheckSnapshot,
	LifecycleHealthSnapshot,
	LifecycleHealthState,
	LifecycleHookDisposer
} from '@ooopsstudio/core/contracts/lifecycle'

import {
	MAX_HEALTH_CHECKS,
	REQUIRED_HEALTH_FAILURE_THRESHOLD
} from '../constants'

import {lifecycleIdentifier, snapshotRecord, stableErrorMessage} from './lifecycle-handler-validation'

interface HealthEntry {
	readonly name: string
	readonly criticality: 'required' | 'optional'
	readonly check: LifecycleHealthCheckDefinition['check']
	healthy: boolean
	consecutiveFailures: number
	critical: boolean
	checkedAt: number
	code: string | undefined
	physical: Promise<LifecycleHealthCheckResult> | undefined
}

export interface HealthManagerOptions {
	readonly clock: Clock
	readonly intervalMs: number
	readonly checkTimeoutMs: number
	readonly runTimeoutMs: number
	readonly concurrency: number
	readonly onHealthFailure?: (criticality: 'required' | 'optional') => void
	readonly onDegradation?: (severity: LifecycleDegradationSeverity) => void
	readonly onChange?: () => void
}

const DEFINITION_FIELDS = new Set(['name', 'criticality', 'check'])
const RESULT_FIELDS = new Set(['healthy', 'code', 'critical'])

function sanitizeCode(value: unknown, fallback: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 128) return fallback
	const normalized = value.trim().replace(/[^A-Za-z0-9._:-]/gu, '_')
	return normalized || fallback
}

function snapshotResult(value: unknown): LifecycleHealthCheckResult {
	const record = snapshotRecord(value, 'Lifecycle health check result', RESULT_FIELDS)
	if (record.healthy !== true && record.healthy !== false) {
		throw new Error('Lifecycle health check healthy must be a boolean')
	}
	if (record.healthy === true) {
		if (record.code !== undefined || record.critical !== undefined) {
			throw new Error('Healthy lifecycle check results cannot include failure fields')
		}
		return Object.freeze({healthy: true})
	}
	if (record.critical !== undefined && typeof record.critical !== 'boolean') {
		throw new Error('Lifecycle health check critical must be a boolean')
	}
	return Object.freeze({
		healthy: false,
		...(record.code === undefined ? {} : {code: sanitizeCode(record.code, 'LIFECYCLE_HEALTH_CHECK_FAILURE')}),
		...(record.critical === true ? {critical: true} : {})
	})
}

function timeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				onTimeout()
				reject(new Error('LIFECYCLE_HEALTH_CHECK_TIMEOUT'))
			}, timeoutMs)
		})
	]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

export class HealthManager {
	private readonly checks = new Map<string, HealthEntry>()
	private readonly degradations = new Map<string, LifecycleDegradationSeverity>()
	private readonly controllers = new Set<AbortController>()
	private readonly physicalChecks = new Set<Promise<LifecycleHealthCheckResult>>()
	private interval: ReturnType<typeof setInterval> | undefined
	private activeRun: Promise<void> | undefined
	private accepting = true
	private closed = false
	private lastCheckedAt: number

	constructor(private readonly options: HealthManagerOptions) {
		this.lastCheckedAt = options.clock.now()
	}

	register(definition: LifecycleHealthCheckDefinition): LifecycleHookDisposer {
		if (!this.accepting) throw new Error('Lifecycle health registration is closed')
		if (this.checks.size >= MAX_HEALTH_CHECKS) throw new Error('Lifecycle health check limit exceeded')
		const snapshot = snapshotRecord(definition, 'Lifecycle health check definition', DEFINITION_FIELDS)
		const name = lifecycleIdentifier(snapshot.name, 'Lifecycle health check name')
		if (snapshot.criticality !== 'required' && snapshot.criticality !== 'optional') {
			throw new Error('Lifecycle health check criticality is invalid')
		}
		if (typeof snapshot.check !== 'function') throw new Error('Lifecycle health check must be a function')
		if (this.checks.has(name)) throw new Error(`Lifecycle health check already registered: ${name}`)
		// Definition descriptors may re-enter registration while being inspected.
		// Re-check after inspection to prevent nested calls from exceeding the cap.
		if (this.checks.size >= MAX_HEALTH_CHECKS) throw new Error('Lifecycle health check limit exceeded')
		const check = snapshot.check as LifecycleHealthCheckDefinition['check']
		const entry: HealthEntry = {
			name,
			criticality: snapshot.criticality,
			check: (context) => Reflect.apply(check, undefined, [context]),
			healthy: true,
			consecutiveFailures: 0,
			critical: false,
			checkedAt: this.options.clock.now(),
			code: undefined,
			physical: undefined
		}
		this.checks.set(name, entry)
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.checks.get(name) === entry) this.checks.delete(name)
			this.changed()
		}
	}

	recordDegradation(code: string, severity: LifecycleDegradationSeverity): void {
		if (this.closed) throw new Error('Lifecycle degradation admission is closed')
		const normalized = lifecycleIdentifier(code, 'Lifecycle degradation code')
		if (severity !== 'warning' && severity !== 'error' && severity !== 'critical') {
			throw new Error('Lifecycle degradation severity is invalid')
		}
		this.degradations.set(normalized, severity)
		this.options.onDegradation?.(severity)
		this.changed()
	}

	clearDegradation(code?: string): void {
		if (this.closed) throw new Error('Lifecycle degradation admission is closed')
		if (code === undefined) this.degradations.clear()
		else this.degradations.delete(lifecycleIdentifier(code, 'Lifecycle degradation code'))
		this.changed()
	}

	async start(): Promise<void> {
		if (!this.accepting || this.checks.size === 0) return
		await this.runOnce()
		if (!this.accepting || this.options.intervalMs <= 0 || this.interval) return
		this.interval = setInterval(() => {
			void this.runOnce().catch(() => undefined)
		}, this.options.intervalMs)
		this.interval.unref?.()
	}

	beginDrain(): void {
		this.accepting = false
		if (this.interval) clearInterval(this.interval)
		this.interval = undefined
	}

	async drain(): Promise<void> {
		this.beginDrain()
		for (const controller of this.controllers) {
			controller.abort(new Error('LIFECYCLE_DRAINING'))
		}
		const physical = new Set<Promise<unknown>>()
		if (this.activeRun) physical.add(this.activeRun)
		for (const check of this.physicalChecks) physical.add(check)
		if (physical.size === 0) return
		await timeout(Promise.allSettled([...physical]).then(() => undefined), this.options.runTimeoutMs, () => {
			for (const controller of this.controllers) controller.abort(new Error('LIFECYCLE_HEALTH_DRAIN_TIMEOUT'))
		})
	}

	close(): void {
		this.beginDrain()
		this.closed = true
		this.changed()
	}

	getHealth(): LifecycleHealthState {
		if (this.closed) return 'closed'
		if ([...this.degradations.values()].includes('critical')) return 'unhealthy'
		for (const entry of this.checks.values()) {
			if (entry.criticality === 'required' && (
				entry.critical || entry.consecutiveFailures >= REQUIRED_HEALTH_FAILURE_THRESHOLD
			)) return 'unhealthy'
		}
		if (this.degradations.size > 0) return 'degraded'
		for (const entry of this.checks.values()) {
			if (!entry.healthy) return 'degraded'
		}
		return 'healthy'
	}

	failedChecks(): number {
		let count = 0
		for (const entry of this.checks.values()) if (!entry.healthy) count++
		return count
	}

	getSnapshot(): LifecycleHealthSnapshot {
		const checks: Record<string, LifecycleHealthCheckSnapshot> = Object.create(null) as Record<
			string,
			LifecycleHealthCheckSnapshot
		>
		for (const [name, entry] of this.checks) {
			checks[name] = Object.freeze({
				healthy: entry.healthy,
				criticality: entry.criticality,
				consecutiveFailures: entry.consecutiveFailures,
				...(entry.code ? {code: entry.code} : {}),
				checkedAt: entry.checkedAt
			})
		}
		return Object.freeze({
			health: this.getHealth(),
			checkedAt: this.lastCheckedAt,
			checks: Object.freeze(checks)
		})
	}

	private changed(): void {
		try { this.options.onChange?.() } catch { /* observers never affect health */ }
	}

	private runOnce(): Promise<void> {
		if (!this.accepting) return Promise.resolve()
		if (this.activeRun) return Promise.resolve()
		let runActive = true
		const pending = new Set(this.checks.values())
		const physical = this.executeRun(() => runActive, pending)
		const owned = physical.finally(() => {
			if (this.activeRun === owned) this.activeRun = undefined
		})
		this.activeRun = owned
		return timeout(owned, this.options.runTimeoutMs, () => {
			runActive = false
			for (const controller of this.controllers) controller.abort(new Error('LIFECYCLE_HEALTH_RUN_TIMEOUT'))
			for (const entry of pending) {
				if (this.checks.get(entry.name) === entry) {
					this.recordFailure(entry, 'LIFECYCLE_HEALTH_RUN_TIMEOUT', false)
				}
			}
			this.lastCheckedAt = this.options.clock.now()
			this.changed()
		}).catch(() => undefined)
	}

	private async executeRun(runActive: () => boolean, pending: Set<HealthEntry>): Promise<void> {
		const entries = [...this.checks.values()]
		let next = 0
		const workerCount = Math.min(this.options.concurrency, entries.length)
		const workers = Array.from({length: workerCount}, async() => {
			while (this.accepting && runActive()) {
				const entry = entries[next++]
				if (!entry) return
				await this.executeCheck(entry, runActive)
				pending.delete(entry)
			}
		})
		await Promise.all(workers)
		if (!runActive()) return
		this.lastCheckedAt = this.options.clock.now()
		this.changed()
	}

	private async executeCheck(entry: HealthEntry, runActive: () => boolean): Promise<void> {
		if (entry.physical) {
			if (runActive()) this.recordFailure(entry, 'LIFECYCLE_HEALTH_CHECK_BUSY', false)
			return
		}
		const controller = new AbortController()
		this.controllers.add(controller)
		let physical: Promise<LifecycleHealthCheckResult>
		try {
			physical = Promise.resolve(entry.check({signal: controller.signal})).then(snapshotResult)
		} catch {
			physical = Promise.reject(new Error('LIFECYCLE_HEALTH_CHECK_FAILURE'))
		}
		entry.physical = physical
		this.physicalChecks.add(physical)
		void physical.finally(() => {
			if (entry.physical === physical) entry.physical = undefined
			this.physicalChecks.delete(physical)
		}).catch(() => undefined)
		try {
			const result = await timeout(physical, this.options.checkTimeoutMs, () => {
				controller.abort(new Error('LIFECYCLE_HEALTH_CHECK_TIMEOUT'))
			})
			if (!runActive()) return
			if (result.healthy) {
				entry.healthy = true
				entry.consecutiveFailures = 0
				entry.critical = false
				entry.code = undefined
				entry.checkedAt = this.options.clock.now()
			} else {
				this.recordFailure(entry, result.code ?? 'LIFECYCLE_HEALTH_CHECK_FAILURE', result.critical === true)
			}
		} catch(error) {
			if (!runActive()) return
			const code = stableErrorMessage(error) === 'LIFECYCLE_HEALTH_CHECK_TIMEOUT'
				? 'LIFECYCLE_HEALTH_CHECK_TIMEOUT'
				: 'LIFECYCLE_HEALTH_CHECK_FAILURE'
			this.recordFailure(entry, code, false)
		} finally {
			this.controllers.delete(controller)
		}
	}

	private recordFailure(entry: HealthEntry, code: string, critical: boolean): void {
		entry.healthy = false
		entry.consecutiveFailures++
		entry.critical ||= critical
		entry.code = sanitizeCode(code, 'LIFECYCLE_HEALTH_CHECK_FAILURE')
		entry.checkedAt = this.options.clock.now()
		this.options.onHealthFailure?.(entry.criticality)
	}
}
