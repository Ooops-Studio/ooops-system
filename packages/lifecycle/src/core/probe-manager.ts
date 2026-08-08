import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {
	LifecycleHealthState,
	LifecycleRuntimeState,
	LivenessProbeResponse,
	ReadinessProbeResponse
} from '@ooopsstudio/core/contracts/lifecycle'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'

export interface ProbeManagerOptions {
	readonly clock: Clock
	readonly resource?: ObservabilityResource
	readonly getState: () => LifecycleRuntimeState
	readonly getHealth: () => LifecycleHealthState
}

export class ProbeManager {
	constructor(private readonly options: ProbeManagerOptions) {}

	private timestamp(): number {
		try {
			const value = this.options.clock.now()
			return Number.isFinite(value) ? value : Date.now()
		} catch {
			return Date.now()
		}
	}

	getLivenessStatus(): LivenessProbeResponse {
		const closed = this.options.getState() === 'closed'
		return Object.freeze({
			status: closed ? 'error' : 'ok',
			code: closed ? 500 : 200,
			timestamp: this.timestamp()
		})
	}

	getReadinessStatus(): ReadinessProbeResponse {
		const state = this.options.getState()
		const health = this.options.getHealth()
		const ready = state === 'running' && health !== 'unhealthy' && health !== 'closed'
		return Object.freeze({
			status: ready ? 'ok' : 'error',
			code: ready ? 200 : 503,
			state,
			health,
			timestamp: this.timestamp(),
			...(this.options.resource ? {resource: this.options.resource} : {})
		})
	}
}
