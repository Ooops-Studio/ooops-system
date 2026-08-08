/**
 * @file Stable lifecycle contracts.
 */

import {containNativePromiseUnchecked} from '../runtime/async/native-promise'
import {isProxyObject} from '../utils/safe-object'

import type {ObservabilityResource} from './observability-shared'

const nativeReflectApply = Reflect.apply
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeStringCharCodeAt = String.prototype.charCodeAt

export type LifecycleRuntimeState = 'idle' | 'starting' | 'running' | 'draining' | 'closed'
export type LifecycleHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'
export type LifecycleStartupStage = 'init' | 'warm' | 'ready'
export type LifecycleShutdownReason = 'signal' | 'timeout' | 'error' | 'upgrade' | 'manual'
export type LifecycleDegradationSeverity = 'warning' | 'error' | 'critical'
export type ProbeStatus = 'ok' | 'error'

export interface LifecycleStatus {
	readonly state: LifecycleRuntimeState
	readonly health: LifecycleHealthState
	readonly startupStage?: LifecycleStartupStage
	readonly activeHooks: number
	readonly failedChecks: number
	readonly lastFailureCode?: string
}

export type LifecycleHealthCheckResult =
	| {readonly healthy: true}
	| {
		readonly healthy: false
		readonly code?: string
		readonly critical?: boolean
	}

export interface LifecycleHealthCheckContext {
	readonly signal: AbortSignal
}

export interface LifecycleHealthCheckDefinition {
	readonly name: string
	readonly criticality: 'required' | 'optional'
	readonly check: (
		context: LifecycleHealthCheckContext
	) => LifecycleHealthCheckResult | Promise<LifecycleHealthCheckResult>
}

export interface LifecycleHealthCheckSnapshot {
	readonly healthy: boolean
	readonly criticality: 'required' | 'optional'
	readonly consecutiveFailures: number
	readonly code?: string
	readonly checkedAt: number
}

export interface LifecycleHealthSnapshot {
	readonly health: LifecycleHealthState
	readonly checkedAt: number
	readonly checks: Readonly<Record<string, LifecycleHealthCheckSnapshot>>
}

export interface LifecycleStartupContext {
	readonly stage: LifecycleStartupStage
	readonly startedAt: number
	readonly signal: AbortSignal
}

export interface LifecycleShutdownContext {
	readonly reason: LifecycleShutdownReason
	readonly startedAt: number
	readonly signal?: string
	readonly abortSignal: AbortSignal
}

export interface LifecycleFlushContext {
	readonly signal: AbortSignal
}

export type StartupHook = (context: LifecycleStartupContext) => void | Promise<void>
export type ShutdownHook = (context: LifecycleShutdownContext) => void | Promise<void>
export type LifecycleFlushHook = (context: LifecycleFlushContext) => void | Promise<void>
export type LifecycleHookDisposer = () => void

export interface LifecycleStartupHookOptions {
	readonly name?: string
	readonly concurrent?: boolean
	readonly group?: string
	/** Only warm hooks may be optional. Init and ready hooks are always required. */
	readonly required?: boolean
}

export interface LifecycleShutdownHookOptions {
	readonly name?: string
	readonly priority?: number
}

export interface LivenessProbeResponse {
	readonly status: ProbeStatus
	readonly code: 200 | 500
	readonly timestamp: number
}

export interface ReadinessProbeResponse {
	readonly status: ProbeStatus
	readonly code: 200 | 503
	readonly state: LifecycleRuntimeState
	readonly health: LifecycleHealthState
	readonly timestamp: number
	readonly resource?: ObservabilityResource
}

function readLifecycleErrorOption(value: unknown, key: 'cause' | 'state' | 'health'): unknown {
	containNativePromiseUnchecked(value)
	if (!value || typeof value !== 'object' || isProxyObject(value)) return undefined
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
		const result = descriptor && 'value' in descriptor ? descriptor.value : undefined
		containNativePromiseUnchecked(result)
		return result
	} catch { return undefined }
}

function safeLifecycleMessage(value: unknown): string {
	if (typeof value !== 'string' || value.length > 1_024) return 'Lifecycle operation failed'
	for (let index = 0; index < value.length; index += 1) {
		const code = nativeReflectApply(nativeStringCharCodeAt, value, [index]) as number
		if (code <= 31 || code === 127) return 'Lifecycle operation failed'
	}
	return value
}

function isLifecycleState(value: unknown): value is LifecycleRuntimeState {
	return value === 'idle' || value === 'starting' || value === 'running' || value === 'draining' || value === 'closed'
}

function isLifecycleHealth(value: unknown): value is LifecycleHealthState {
	return value === 'healthy' || value === 'degraded' || value === 'unhealthy' || value === 'closed'
}

export class LifecycleError extends Error {
	readonly state?: LifecycleRuntimeState
	readonly health?: LifecycleHealthState

	constructor(
		message: string,
		options?: {
			cause?: unknown
			state?: LifecycleRuntimeState
			health?: LifecycleHealthState
		}
	) {
		containNativePromiseUnchecked(message)
		containNativePromiseUnchecked(options)
		const cause = readLifecycleErrorOption(options, 'cause')
		const state = readLifecycleErrorOption(options, 'state')
		const health = readLifecycleErrorOption(options, 'health')
		containNativePromiseUnchecked(cause)
		super(safeLifecycleMessage(message), cause === undefined ? undefined : {cause})
		this.name = new.target === LifecycleStartupError ? 'LifecycleStartupError'
			: new.target === LifecycleShutdownTimeoutError ? 'LifecycleShutdownTimeoutError'
				: 'LifecycleError'
		if (isLifecycleState(state)) this.state = state
		if (isLifecycleHealth(health)) this.health = health
	}
}

export class LifecycleStartupError extends LifecycleError {}
export class LifecycleShutdownTimeoutError extends LifecycleError {}
