import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {AuditAdminPort, AuditRuntime, TransactionalAuditPort} from '@ooopsstudio/core/ports/audit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {AUDIT_FLUSH_TIMEOUT_MS, AUDIT_MAXIMUM_LIMITS, AUDIT_SHUTDOWN_TIMEOUT_MS} from '../constants'
import type {AdminCapableAuditStore, TransactionalAuditStore} from '../types/store'

import {createAuditRuntime} from './handler'

export interface StandardAuditHandlerOptions<Transactional extends boolean, Admin extends boolean> {
	readonly clock: Clock
	readonly store: AdminCapableAuditStore & (Transactional extends true ? TransactionalAuditStore : object)
	readonly transactional: Transactional
	readonly admin: Admin
	readonly resource?: ObservabilityResource
	readonly lifecycle?: LifecyclePort
}

export type StandardAuditRuntime<Transactional extends boolean, Admin extends boolean> = AuditRuntime
	& (Transactional extends true ? {readonly transactional: TransactionalAuditPort} : {readonly transactional?: never})
	& (Admin extends true ? {readonly admin: AuditAdminPort} : {readonly admin?: never})

/**
 * Fixed standard composition. Custom tracing, archive delivery, custom
 * redaction validation and policy tuning stay outside this import graph.
 */
export function createStandardAuditHandler<Transactional extends boolean, Admin extends boolean>(
	options: StandardAuditHandlerOptions<Transactional, Admin>
): StandardAuditRuntime<Transactional, Admin> {
	return createAuditRuntime({
		...options,
		...(options.transactional ? {transactionalStore: options.store as AdminCapableAuditStore & TransactionalAuditStore} : {}),
		...(options.admin ? {adminStore: options.store} : {}),
		limits: AUDIT_MAXIMUM_LIMITS,
		redactionRules: [],
		flushTimeoutMs: AUDIT_FLUSH_TIMEOUT_MS,
		shutdownTimeoutMs: AUDIT_SHUTDOWN_TIMEOUT_MS
	}) as StandardAuditRuntime<Transactional, Admin>
}
