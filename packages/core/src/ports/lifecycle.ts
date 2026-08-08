/**
 * @file Lifecycle capability and managed runtime contracts.
 */

import type {
	LifecycleDegradationSeverity,
	LifecycleFlushHook,
	LifecycleHealthCheckDefinition,
	LifecycleHealthSnapshot,
	LifecycleHookDisposer,
	LifecycleShutdownHookOptions,
	LifecycleShutdownReason,
	LifecycleStartupHookOptions,
	LifecycleStartupStage,
	LifecycleStatus,
	LivenessProbeResponse,
	ReadinessProbeResponse,
	ShutdownHook,
	StartupHook
} from '../contracts/lifecycle'

/** Small coordination surface consumed by sibling services. */
export interface LifecyclePort {
	getStatus(): LifecycleStatus
	registerFlushHook(name: string, hook: LifecycleFlushHook): LifecycleHookDisposer
	registerShutdownHook(
		group: string,
		hook: ShutdownHook,
		options?: LifecycleShutdownHookOptions
	): LifecycleHookDisposer
	registerHealthCheck(definition: LifecycleHealthCheckDefinition): LifecycleHookDisposer
	recordDegradation(code: string, severity: LifecycleDegradationSeverity): void
	clearDegradation(code?: string): void
}

/** Full runtime returned by lifecycle presets. */
export interface ManagedLifecycle extends LifecyclePort {
	start(): Promise<void>
	registerStartupHook(
		stage: LifecycleStartupStage,
		hook: StartupHook,
		options?: LifecycleStartupHookOptions
	): LifecycleHookDisposer
	getHealthSnapshot(): LifecycleHealthSnapshot
	getLivenessStatus(): LivenessProbeResponse
	getReadinessStatus(): ReadinessProbeResponse
	beginDrain(reason?: LifecycleShutdownReason): Promise<void>
	flush(): Promise<void>
	shutdown(reason?: LifecycleShutdownReason): Promise<void>
}
