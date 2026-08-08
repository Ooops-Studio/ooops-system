import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createStandardAuditHandler} from '../core/standard-handler'
import {createPostgresAuditStore, type PostgresAuditStoreOptions} from '../features/stores/postgres-store'
import {captureAuditClock} from '../utils/capabilities'

import {snapshotAuditPresetOptions, snapshotAuditResource} from './options'

const productionOptionFields = new Set(['postgres', 'clock', 'resource', 'lifecycle'])

export interface ProductionAuditOptions {
	readonly postgres: PostgresAuditStoreOptions
	readonly clock?: Clock
	readonly resource?: ObservabilityResource
	readonly lifecycle?: LifecyclePort
}

export async function createProductionAudit(options: ProductionAuditOptions) {
	options = snapshotAuditPresetOptions(options, productionOptionFields, 'Production audit') as unknown as ProductionAuditOptions
	if (!options.postgres || typeof options.postgres !== 'object') throw new Error('Production audit requires PostgreSQL configuration.')
	const clock = captureAuditClock(options.clock ?? createSystemClock())
	const resource = snapshotAuditResource(options.resource)
	const store = createPostgresAuditStore(options.postgres)
	try {
		await store.verifyCompatibility()
		store.assertCallerTransactionsSupported()
		return createStandardAuditHandler({
			clock, store, transactional: true, admin: true,
			...(resource ? {resource} : {}),
			...(options.lifecycle ? {lifecycle: options.lifecycle} : {})
		})
	} catch(error) {
		try { await store.shutdown?.() } catch { /* preserve construction failure */ }
		throw error
	}
}
