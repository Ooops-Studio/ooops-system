import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {AuditRuntime} from '@ooopsstudio/core/ports/audit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import type {
	AuditAdminStore,
	AuditArchiveSink,
	AuditRedactionRule,
	AuditSafetyLimits,
	AuditStore,
	TransactionalAuditStore
} from '../types/store'
import {captureAuditCapability} from '../utils/capabilities'

import {resolveAuditLimits, resolveAuditTimeouts, snapshotAuditRedactionRules} from './custom-options'
import {createAuditRuntime, type AuditRuntimeOptions} from './handler'

export interface AuditHandlerOptions {
	readonly clock: Clock
	readonly store: AuditStore
	readonly transactionalStore?: TransactionalAuditStore
	readonly adminStore?: AuditAdminStore
	readonly adminLifecycle?: Pick<AuditAdminStore, 'flush' | 'shutdown'>
	readonly lifecycle?: LifecyclePort
	readonly archiveSink?: AuditArchiveSink
	readonly resource?: ObservabilityResource
	readonly redactionRules?: readonly AuditRedactionRule[]
	readonly limits?: Partial<AuditSafetyLimits>
	readonly flushTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
}

export function createAuditHandler(options: AuditHandlerOptions): AuditRuntime {
	const timeouts = resolveAuditTimeouts(options.flushTimeoutMs, options.shutdownTimeoutMs)
	const limits = resolveAuditLimits(options.limits)
	const archive = captureAuditCapability<Parameters<AuditArchiveSink['archive']>, ReturnType<AuditArchiveSink['archive']>>(options.archiveSink, 'archive')
	const archiveFlush = captureAuditCapability<[], Promise<void>>(options.archiveSink, 'flush')
	const archiveShutdown = captureAuditCapability<[], Promise<void>>(options.archiveSink, 'shutdown')
	const runtimeOptions: AuditRuntimeOptions = {
		clock: options.clock,
		store: options.store,
		...(options.transactionalStore ? {transactionalStore: options.transactionalStore} : {}),
		...(options.adminStore ? {adminStore: options.adminStore} : {}),
		...(options.adminLifecycle ? {adminLifecycle: options.adminLifecycle} : {}),
		...(options.lifecycle ? {lifecycle: options.lifecycle} : {}),
		...(options.resource ? {resource: options.resource} : {}),
		limits,
		redactionRules: snapshotAuditRedactionRules(options.redactionRules, limits),
		...timeouts,
		...(archive ? {
			archivePlan: async(plan) => {
				const {archiveAuditPlan} = await import('./admin-archive')
				return await archiveAuditPlan({archive}, plan)
			},
			archiveLifecycle: {
				...(archiveFlush ? {flush: archiveFlush} : {}),
				...(archiveShutdown ? {shutdown: archiveShutdown} : {})
			}
		} : {})
	}
	return createAuditRuntime(runtimeOptions)
}
