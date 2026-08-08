import type {LifecycleHealthState} from '@ooopsstudio/core/contracts/lifecycle'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {captureLoggingMethod} from '../utils/capabilities'

const LIFECYCLE_HEALTH_STATES = new Set<LifecycleHealthState>([
	'healthy', 'degraded', 'unhealthy', 'closed'
])

export interface LoggerLifecycleState {
	isDraining: boolean
	healthStatus: LifecycleHealthState
}

export function createLifecycleStateSync(
	lifecycle: LifecyclePort | undefined,
	state: LoggerLifecycleState,
	onError: (error: unknown) => void
): () => void {
	let syncing = false
	let reportingSyncFailure = false
	const syncLifecycleState = (): void => {
		// A lifecycle implementation may report diagnostics through this logger.
		// Keep that synchronous feedback path from recursively calling getStatus()
		// before the logger's normal admission guard can take ownership.
		if (syncing) return
		syncing = true
		try {
			const getStatus = captureLoggingMethod<LifecyclePort['getStatus']>(lifecycle, 'getStatus')
			const status = getStatus?.call(lifecycle)
			if (captureLoggingMethod(status, 'then')) {
				state.isDraining = false
				state.healthStatus = 'unhealthy'
				void Promise.resolve(status).catch(onError)
				return
			}
			state.isDraining = status?.state === 'draining' || status?.state === 'closed'
			const health: unknown = status?.health
			state.healthStatus = LIFECYCLE_HEALTH_STATES.has(health as LifecycleHealthState)
				? health as LifecycleHealthState
				: status ? 'unhealthy' : 'healthy'
		} finally {
			syncing = false
		}
	}

	const syncLifecycleStateSafe = (): void => {
		try {
			syncLifecycleState()
		} catch(error) {
			// The Errors port may itself emit through this logger. Keep a failing
			// lifecycle probe from recursively reporting the same integration path
			// before logger admission can move the diagnostic onto the async pipeline.
			if (reportingSyncFailure) return
			reportingSyncFailure = true
			try {
				onError(error)
			} finally {
				reportingSyncFailure = false
			}
		}
	}

	return syncLifecycleStateSafe
}

export async function waitForSettled(promises: ReadonlySet<Promise<unknown>>): Promise<void> {
	await Promise.allSettled([...promises])
}
