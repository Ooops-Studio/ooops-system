import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createStandardAuditHandler} from '../core/standard-handler'
import {createMemoryAuditStore} from '../features/stores/memory-store'

import {snapshotAuditPresetOptions, snapshotAuditResource} from './options'

const developmentOptionFields = new Set(['clock', 'resource', 'lifecycle'])

export interface DevelopmentAuditOptions {
	readonly clock?: Clock
	readonly resource?: ObservabilityResource
	readonly lifecycle?: LifecyclePort
}

export async function createDevelopmentAudit(options: DevelopmentAuditOptions = {}) {
	options = snapshotAuditPresetOptions(options, developmentOptionFields, 'Development audit') as unknown as DevelopmentAuditOptions
	const resource = snapshotAuditResource(options.resource)
	return createStandardAuditHandler({
		clock: options.clock ?? createSystemClock(),
		store: createMemoryAuditStore({maxRecords: 10_000, maxBytes: 64 * 1024 * 1024}),
		transactional: false,
		admin: true,
		...(resource ? {resource} : {}),
		...(options.lifecycle ? {lifecycle: options.lifecycle} : {})
	})
}
