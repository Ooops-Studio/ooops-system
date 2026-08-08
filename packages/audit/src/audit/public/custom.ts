import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'

import {AUDIT_SHUTDOWN_TIMEOUT_MS} from '../constants'
import {createAuditHandler} from '../core/custom-handler'
import type {
	AuditAdminStore,
	AuditArchiveSink,
	AuditRedactionRule,
	AuditSerializationLimits,
	AuditStore,
	TransactionalAuditStore
} from '../types/store'
import {captureAuditCapability} from '../utils/capabilities'
import {isAuditSafeString} from '../utils/string-safety'
import {withAuditTimeout} from '../utils/timeout'

import {snapshotAuditPresetOptions, snapshotAuditResource} from './options'

const customOptionFields = new Set([
	'clock', 'store', 'transactionalStore', 'adminStore', 'archiveSink', 'resource', 'redaction', 'finalization', 'lifecycle'
])

export interface CustomAuditOptions {
	readonly clock: Clock
	readonly store: AuditStore
	readonly transactionalStore?: TransactionalAuditStore
	readonly adminStore?: AuditAdminStore
	readonly archiveSink?: AuditArchiveSink
	readonly resource?: ObservabilityResource
	readonly redaction?: {
		readonly additionalRules?: readonly AuditRedactionRule[]
		readonly limits?: Partial<AuditSerializationLimits>
	}
	readonly finalization?: {
		readonly flushTimeoutMs?: number
		readonly shutdownTimeoutMs?: number
	}
	readonly lifecycle?: LifecyclePort
}

function readDataProperty(source: object, name: PropertyKey, label: string): unknown {
	let current: object | null = source
	try {
		for (let depth = 0; current && depth < 16; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if (!('value' in descriptor)) throw new Error()
				return descriptor.value
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { throw new Error(`${label} is not readable.`) }
	return undefined
}

function bindStore(source: AuditStore): AuditStore {
	if (!source || typeof source !== 'object') throw new Error('Custom audit store is invalid.')
	const kind = readDataProperty(source, 'kind', 'Custom audit store kind')
	const appendMany = captureAuditCapability<Parameters<AuditStore['appendMany']>, ReturnType<AuditStore['appendMany']>>(source, 'appendMany')
	const getById = captureAuditCapability<Parameters<AuditStore['getById']>, ReturnType<AuditStore['getById']>>(source, 'getById')
	const query = captureAuditCapability<Parameters<AuditStore['query']>, ReturnType<AuditStore['query']>>(source, 'query')
	const flush = captureAuditCapability<[], Promise<void>>(source, 'flush')
	const shutdown = captureAuditCapability<[], Promise<void>>(source, 'shutdown')
	if (typeof kind !== 'string' || !kind || kind !== kind.trim() || kind.length > 64 || !isAuditSafeString(kind)
		|| !appendMany || !getById || !query) throw new Error('Custom audit requires a complete AuditStore.')
	return Object.freeze({kind, appendMany, getById, query, ...(flush ? {flush} : {}), ...(shutdown ? {shutdown} : {})})
}

function bindTransactionalStore(source: TransactionalAuditStore | undefined): TransactionalAuditStore | undefined {
	if (source === undefined) return undefined
	const appendTransactional = captureAuditCapability<Parameters<TransactionalAuditStore['appendTransactional']>, ReturnType<TransactionalAuditStore['appendTransactional']>>(source, 'appendTransactional')
	if (!appendTransactional) throw new Error('Custom audit transactionalStore is incomplete.')
	return Object.freeze({appendTransactional})
}

function bindAdminStore(source: AuditAdminStore | undefined): AuditAdminStore | undefined {
	if (source === undefined) return undefined
	const verifyIntegrity = captureAuditCapability<Parameters<AuditAdminStore['verifyIntegrity']>, ReturnType<AuditAdminStore['verifyIntegrity']>>(source, 'verifyIntegrity')
	const planPruneBefore = captureAuditCapability<Parameters<AuditAdminStore['planPruneBefore']>, ReturnType<AuditAdminStore['planPruneBefore']>>(source, 'planPruneBefore')
	const prunePlanned = captureAuditCapability<Parameters<AuditAdminStore['prunePlanned']>, ReturnType<AuditAdminStore['prunePlanned']>>(source, 'prunePlanned')
	const flush = captureAuditCapability<[], Promise<void>>(source, 'flush')
	const shutdown = captureAuditCapability<[], Promise<void>>(source, 'shutdown')
	if (!verifyIntegrity || !planPruneBefore || !prunePlanned) throw new Error('Custom audit adminStore must provide all admin capabilities.')
	return Object.freeze({
		verifyIntegrity,
		planPruneBefore,
		prunePlanned,
		...(flush ? {flush} : {}),
		...(shutdown ? {shutdown} : {})
	})
}

function bindArchiveSink(source: AuditArchiveSink | undefined): AuditArchiveSink | undefined {
	if (source === undefined) return undefined
	const archive = captureAuditCapability<Parameters<AuditArchiveSink['archive']>, ReturnType<AuditArchiveSink['archive']>>(source, 'archive')
	const flush = captureAuditCapability<[], Promise<void>>(source, 'flush')
	const shutdown = captureAuditCapability<[], Promise<void>>(source, 'shutdown')
	if (!archive) throw new Error('Custom audit archiveSink is invalid.')
	return Object.freeze({archive, ...(flush ? {flush} : {}), ...(shutdown ? {shutdown} : {})})
}

function snapshotNested(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
	if (value === undefined) return {}
	return snapshotAuditPresetOptions(value, new Set(fields), label)
}

export async function createCustomAudit(options: CustomAuditOptions) {
	options = snapshotAuditPresetOptions(options, customOptionFields, 'Custom audit') as unknown as CustomAuditOptions
	if (!captureAuditCapability(options.clock, 'now') || !options.store) throw new Error('Custom audit requires a clock and store.')
	const store = bindStore(options.store)
	const ownsDistinctAdminStore = options.adminStore !== undefined
		&& (options.adminStore as object) !== (options.store as object)
	const ownsDistinctArchiveLifecycle = options.archiveSink !== undefined
		&& (options.archiveSink as object) !== (options.store as object)
		&& (options.adminStore === undefined || (options.archiveSink as object) !== (options.adminStore as object))
	const adminShutdown = captureAuditCapability<[], Promise<void>>(options.adminStore, 'shutdown')
	const archiveShutdown = captureAuditCapability<[], Promise<void>>(options.archiveSink, 'shutdown')
	try {
		const transactionalStore = bindTransactionalStore(options.transactionalStore)
		const adminStore = bindAdminStore(options.adminStore)
		const archiveSink = bindArchiveSink(options.archiveSink)
		const runtimeArchiveSink = archiveSink && !ownsDistinctArchiveLifecycle
			? Object.freeze({archive: archiveSink.archive})
			: archiveSink
		if (archiveSink && !adminStore) throw new Error('Custom audit archiveSink requires adminStore.')
		const resource = snapshotAuditResource(options.resource)
		const redaction = snapshotNested(options.redaction, ['additionalRules', 'limits'], 'Custom audit redaction')
		const finalization = snapshotNested(options.finalization, ['flushTimeoutMs', 'shutdownTimeoutMs'], 'Custom audit finalization')
		return createAuditHandler({
			clock: options.clock,
			store,
			...(transactionalStore ? {transactionalStore} : {}),
			...(adminStore ? {adminStore} : {}),
			...(ownsDistinctAdminStore && adminStore ? {adminLifecycle: adminStore} : {}),
			...(runtimeArchiveSink ? {archiveSink: runtimeArchiveSink} : {}),
			...(resource ? {resource} : {}),
			...(redaction.additionalRules ? {redactionRules: redaction.additionalRules as readonly AuditRedactionRule[]} : {}),
			...(redaction.limits ? {limits: redaction.limits as Partial<AuditSerializationLimits>} : {}),
			...(finalization.flushTimeoutMs !== undefined ? {flushTimeoutMs: finalization.flushTimeoutMs as number} : {}),
			...(finalization.shutdownTimeoutMs !== undefined ? {shutdownTimeoutMs: finalization.shutdownTimeoutMs as number} : {}),
			...(options.lifecycle ? {lifecycle: options.lifecycle} : {})
		})
	} catch(error) {
		await Promise.allSettled([
			withAuditTimeout(Promise.resolve().then(() => store.shutdown?.()), AUDIT_SHUTDOWN_TIMEOUT_MS, 'construction rollback'),
			withAuditTimeout(Promise.resolve().then(
				() => ownsDistinctAdminStore ? adminShutdown?.() : undefined
			), AUDIT_SHUTDOWN_TIMEOUT_MS, 'admin construction rollback'),
			withAuditTimeout(Promise.resolve().then(
				() => ownsDistinctArchiveLifecycle ? archiveShutdown?.() : undefined
			), AUDIT_SHUTDOWN_TIMEOUT_MS, 'archive construction rollback')
		])
		throw error
	}
}
