import type {AuditVerificationResult} from '@ooopsstudio/core/contracts/audit'
import type {AuditAdminPort} from '@ooopsstudio/core/ports/audit'

import {AUDIT_PRUNE_MAX_BYTES, AUDIT_PRUNE_MAX_RECORDS} from '../constants'
import type {AuditAdminStore, AuditPrunePlan, AuditRedactionRule, AuditSafetyLimits, AuditStore} from '../types/store'
import {isAuditSafeString} from '../utils/string-safety'
import {assertAuditIsoTimestamp, assertAuditPruneLimit, compareAuditTimestamps} from '../utils/validation'

import {validateAuditRecord} from './handler-support'
import {groupAuditRecords, sha256Stable, verifyAuditRecords} from './integrity'

function snapshotObject(value: unknown, allowed: ReadonlyArray<string>, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Audit ${label} is invalid.`)
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || !allowed.includes(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			output[key] = descriptor.value
		}
	} catch { throw new Error(`Audit ${label} must be a readable plain object with known fields.`) }
	return output
}

function snapshotArray(value: unknown, maximum: number, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Audit ${label} is invalid.`)
	try {
		const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
		if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error()
		const allowed = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error()
		return Array.from({length}, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			return descriptor.value
		})
	} catch { throw new Error(`Audit ${label} is invalid.`) }
}

function validatePruneRecords(
	value: unknown,
	limits: AuditSafetyLimits,
	rules: ReadonlyArray<AuditRedactionRule>,
	currentTimeMs: number
): {records: ReadonlyArray<ReturnType<typeof validateAuditRecord>>; bytes: number} {
	const source = snapshotArray(value, AUDIT_PRUNE_MAX_RECORDS, 'prune records')
	const records: Array<ReturnType<typeof validateAuditRecord>> = []
	let bytes = 2
	for (const raw of source) {
		const record = validateAuditRecord(raw, limits, rules, currentTimeMs)
		bytes += Buffer.byteLength(JSON.stringify(record)) + (records.length > 0 ? 1 : 0)
		if (bytes > AUDIT_PRUNE_MAX_BYTES) throw new Error('Audit prune plan exceeds the serialized byte limit.')
		records.push(record)
	}
	return {records: Object.freeze(records), bytes}
}

export interface AuditAdminOptions {
	readonly store: AuditStore & AuditAdminStore
	readonly now: () => number
	readonly limits: AuditSafetyLimits
	readonly redactionRules: ReadonlyArray<AuditRedactionRule>
	readonly archivePlan?: (plan: AuditPrunePlan) => Promise<number>
	readonly track: <T>(operation: () => Promise<T>) => Promise<T>
	readonly markDirty: () => void
	readonly observeFailure: (operation: string, error: unknown) => Promise<void>
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
	for (const nested of Object.values(value)) deepFreeze(nested)
	return Object.freeze(value)
}

export function createAuditAdmin(options: AuditAdminOptions): AuditAdminPort {
	return {
		async export(request) {
			return await options.track(async() => { try {
				const {exportAuditRecords} = await import('./query-export')
				return deepFreeze(await exportAuditRecords(options.store, request, options.limits, options.redactionRules, options.now))
			} catch(error) { await options.observeFailure('export', error); throw error } })
		},
		async verifyIntegrity(filter) {
			return await options.track(async() => { try {
				const input = Object.freeze(filter === undefined
					? {}
					: snapshotObject(filter, ['partitionKey', 'from', 'to'], 'verification filter'))
				assertAuditIsoTimestamp(input.from, 'filter.from')
				assertAuditIsoTimestamp(input.to, 'filter.to')
				if (input.partitionKey !== undefined && (typeof input.partitionKey !== 'string' || !input.partitionKey
					|| input.partitionKey !== input.partitionKey.trim() || input.partitionKey.length > 512
					|| !isAuditSafeString(input.partitionKey))) throw new Error('Audit verification partitionKey is invalid.')
				if (typeof input.from === 'string' && typeof input.to === 'string'
					&& compareAuditTimestamps(input.from, input.to) > 0) throw new Error('Audit verification from must not be after to.')
				const raw = await options.store.verifyIntegrity(input)
				const result = snapshotObject(raw, ['ok', 'checkedCount', 'partitionKey', 'brokenAtRecordId', 'brokenAtSequence', 'affectedRecordIds'], 'verification result')
				const affectedRecordIds = snapshotArray(result.affectedRecordIds, 500, 'verification affectedRecordIds')
				const uniqueAffectedRecordIds = new Set(affectedRecordIds)
				if (
					typeof result.ok !== 'boolean' || !Number.isSafeInteger(result.checkedCount)
					|| (result.checkedCount as number) < 0
					|| affectedRecordIds.some((id) => typeof id !== 'string' || !id || id !== id.trim() || id.length > 512 || !isAuditSafeString(id))
					|| uniqueAffectedRecordIds.size !== affectedRecordIds.length
					|| (result.partitionKey !== undefined && (typeof result.partitionKey !== 'string' || !result.partitionKey
						|| result.partitionKey !== result.partitionKey.trim() || result.partitionKey.length > 512
						|| !isAuditSafeString(result.partitionKey)))
					|| (result.brokenAtRecordId !== undefined && (typeof result.brokenAtRecordId !== 'string' || !result.brokenAtRecordId
						|| result.brokenAtRecordId !== result.brokenAtRecordId.trim() || result.brokenAtRecordId.length > 512
						|| !isAuditSafeString(result.brokenAtRecordId)))
					|| (result.brokenAtSequence !== undefined
						&& (!Number.isSafeInteger(result.brokenAtSequence) || (result.brokenAtSequence as number) <= 0))
					|| (result.ok && (affectedRecordIds.length > 0 || result.brokenAtRecordId !== undefined
						|| result.brokenAtSequence !== undefined))
					|| (!result.ok && (result.brokenAtRecordId === undefined
						|| result.brokenAtSequence === undefined || !affectedRecordIds.includes(result.brokenAtRecordId)))
					|| (input.partitionKey !== undefined && result.partitionKey !== input.partitionKey)
				) throw new Error('Audit store returned an invalid verification result.')
				const verification: AuditVerificationResult = {
					ok: result.ok as boolean,
					checkedCount: result.checkedCount as number,
					...(result.partitionKey === undefined ? {} : {partitionKey: result.partitionKey as string}),
					...(result.brokenAtRecordId === undefined ? {} : {brokenAtRecordId: result.brokenAtRecordId as string}),
					...(result.brokenAtSequence === undefined ? {} : {brokenAtSequence: result.brokenAtSequence as number}),
					affectedRecordIds: affectedRecordIds as string[]
				}
				return deepFreeze(verification)
			} catch(error) { await options.observeFailure('verify_integrity', error); throw error } })
		},
		async pruneBefore(cutoff, pruneOptions) {
			return await options.track(async() => { try {
				if (!Number.isFinite(cutoff) || cutoff < 0) throw new Error('Audit prune cutoff must be a non-negative timestamp.')
				const before = new Date(cutoff).toISOString()
				const input: Readonly<Record<string, unknown>> = pruneOptions === undefined
					? Object.freeze({})
					: snapshotObject(pruneOptions, ['limit', 'archive'], 'prune options')
				if (input.archive !== undefined && typeof input.archive !== 'boolean') throw new Error('Audit prune archive must be a boolean.')
				const limit = input.limit ?? 500
				if (typeof limit !== 'number') throw new Error('Audit prune limit must be a number.')
				assertAuditPruneLimit(limit, AUDIT_PRUNE_MAX_RECORDS)
				const raw = snapshotObject(await options.store.planPruneBefore(before, limit), ['planId', 'before', 'partitionKeys', 'records', 'anchors'], 'prune plan')
				const validatedRecords = validatePruneRecords(raw.records, options.limits, options.redactionRules, options.now())
				const plan = Object.freeze({
					planId: raw.planId as string,
					before: raw.before as string,
					partitionKeys: Object.freeze(snapshotArray(raw.partitionKeys, AUDIT_PRUNE_MAX_RECORDS, 'prune partitionKeys') as string[]),
					records: validatedRecords.records,
					anchors: Object.freeze(snapshotArray(raw.anchors, AUDIT_PRUNE_MAX_RECORDS, 'prune anchors').map((anchor) => Object.freeze(snapshotObject(anchor, ['partitionKey', 'count', 'firstRecordId', 'firstHash', 'lastRecordId', 'lastHash'], 'prune anchor'))))
				})
				const keySet = new Set(plan.partitionKeys)
				const recordIds = new Set(plan.records.map((record) => record.id))
				const anchorKeys = new Set(plan.anchors.map((anchor) => anchor.partitionKey))
				const recordsByPartition = groupAuditRecords(plan.records)
				const integrity = verifyAuditRecords(plan.records)
				if (
					typeof plan.planId !== 'string' || !/^[a-f0-9]{64}$/.test(plan.planId)
					|| plan.before !== before || plan.records.length > limit
					|| plan.partitionKeys.some((key) => typeof key !== 'string' || !key || key !== key.trim()
						|| key.length > 512 || !isAuditSafeString(key))
					|| (plan.records.length === 0 && (plan.partitionKeys.length > 0 || plan.anchors.length > 0))
					|| (plan.records.length > 0 && plan.partitionKeys.length === 0)
					|| keySet.size !== plan.partitionKeys.length || plan.anchors.length !== plan.partitionKeys.length
					|| anchorKeys.size !== plan.anchors.length
					|| recordIds.size !== plan.records.length
					|| !integrity.ok || integrity.checkedCount !== plan.records.length
					|| plan.records.some((record) => !keySet.has(record.integrity.partitionKey)
						|| compareAuditTimestamps(record.occurredAt, plan.before) >= 0)
					|| plan.anchors.some((anchor) => typeof anchor.partitionKey !== 'string' || !keySet.has(anchor.partitionKey)
						|| !Number.isSafeInteger(anchor.count) || (anchor.count as number) <= 0
						|| ![anchor.firstRecordId, anchor.lastRecordId].every((id) => typeof id === 'string'
							&& id.length > 0 && id === id.trim() && id.length <= 512 && isAuditSafeString(id))
						|| ![anchor.firstHash, anchor.lastHash].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))
					|| plan.anchors.some((anchor) => {
						const records = recordsByPartition.get(anchor.partitionKey as string) ?? []
						return records.length !== anchor.count || records[0]?.id !== anchor.firstRecordId
							|| records[0]?.integrity.hash !== anchor.firstHash || records.at(-1)?.id !== anchor.lastRecordId
							|| records.at(-1)?.integrity.hash !== anchor.lastHash
					})
					|| validatedRecords.bytes > AUDIT_PRUNE_MAX_BYTES
					|| plan.planId !== sha256Stable({before: plan.before, anchors: plan.anchors})
				) throw new Error('Audit store returned an invalid prune plan.')
				if (plan.records.length === 0) return deepFreeze({deletedCount: 0, ...(input.archive ? {archivedCount: 0} : {})})
				let archivedCount: number | undefined
				if (input.archive) {
					if (!options.archivePlan) throw new Error('Audit archive is not configured for this runtime.')
					options.markDirty()
					archivedCount = await options.archivePlan(plan as unknown as AuditPrunePlan)
					if (!Number.isSafeInteger(archivedCount) || archivedCount !== plan.records.length) {
						throw new Error('Audit archive accepted a different number of records than the immutable prune plan.')
					}
				}
				if (!input.archive) options.markDirty()
				const result = snapshotObject(await options.store.prunePlanned(plan as never), ['deletedCount'], 'prune result')
				if (!Number.isSafeInteger(result.deletedCount) || result.deletedCount !== plan.records.length) throw new Error('Audit store deleted a different number of records than the immutable prune plan.')
				return deepFreeze({deletedCount: result.deletedCount as number, ...(archivedCount !== undefined ? {archivedCount} : {})})
			} catch(error) { await options.observeFailure('prune_before', error); throw error } })
		}
	}
}
