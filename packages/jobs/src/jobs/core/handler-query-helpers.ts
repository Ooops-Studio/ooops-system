import type {RunQuery, ScheduleQuery} from '@ooopsstudio/core/contracts/jobs'

import type {StoredSchedule} from '../types/backend'
import type {InternalRun} from '../types/jobs'
import {snapshotJobsOptions} from '../utils/options'

import {assertStableRecord, validateQueueName} from './handler-helpers'

const JOB_STATUSES = new Set(['queued', 'running', 'retryable', 'completed', 'failed', 'cancelled', 'dead-lettered'])

export function validatePagination(query: {limit?: number; offset?: number} | undefined): void {
	if (query) assertStableRecord(query, 'Jobs pagination')
	if (query?.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 0)) {
		throw new Error('Jobs query limit must be a non-negative integer')
	}
	if (query?.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) {
		throw new Error('Jobs query offset must be a non-negative integer')
	}
}

function snapshotDenseArray<T>(value: readonly T[], label: string): T[] {
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	try {
		prototype = Object.getPrototypeOf(value)
		const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
		if (!Number.isSafeInteger(length) || length < 0 || length > JOB_STATUSES.size) {
			throw new Error(`${label} must be a dense data array`)
		}
		descriptors = Object.getOwnPropertyDescriptors(value as object)
	} catch(error) {
		if (error instanceof Error && error.message === `${label} must be a dense data array`) throw error
		throw new Error(`${label} must expose stable data fields`)
	}
	const symbols = Reflect.ownKeys(descriptors).filter((key) => typeof key === 'symbol')
	if (prototype !== Array.prototype || symbols.length > 0) throw new Error(`${label} must be a dense data array`)
	const length = descriptors.length?.value
	if (!Number.isSafeInteger(length) || length < 0) throw new Error(`${label} must be a dense data array`)
	const result: T[] = new Array(length)
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)]
		if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error(`${label} must be a dense data array`)
		result[index] = descriptor.value as T
	}
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (key === 'length' || (/^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < length)) continue
		if (descriptor.enumerable || !('value' in descriptor)) throw new Error(`${label} must be a dense data array`)
	}
	return result
}

function validateStableRunQuery(query: RunQuery | undefined): void {
	validatePagination(query)
	if (!query) return
	if (query.queue !== undefined) validateQueueName(query.queue)
	if (query.task !== undefined && !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(query.task)) {
		throw new Error('Jobs query task must be a safe identifier')
	}
	if (query.scheduleId !== undefined && !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(query.scheduleId)) {
		throw new Error('Jobs query scheduleId must be a safe identifier')
	}
	const statuses = Array.isArray(query.status) ? query.status : query.status === undefined ? [] : [query.status]
	if (statuses.length > JOB_STATUSES.size || new Set(statuses).size !== statuses.length
		|| statuses.some((status) => !JOB_STATUSES.has(status))) {
		throw new Error('Jobs query status is invalid')
	}
}

export function snapshotRunQuery(query: RunQuery | undefined): RunQuery | undefined {
	if (query === undefined) return undefined
	const snapshot = snapshotJobsOptions<RunQuery>(
		query, new Set(['queue', 'status', 'task', 'scheduleId', 'limit', 'offset']), 'Jobs run query'
	)
	const stable = {...snapshot, ...(Array.isArray(snapshot.status)
		? {status: snapshotDenseArray(snapshot.status, 'Jobs query status')} : {})}
	validateStableRunQuery(stable)
	return stable
}

export function validateRunQuery(query: RunQuery | undefined): void { void snapshotRunQuery(query) }

function validateStableScheduleQuery(query: ScheduleQuery | undefined): void {
	validatePagination(query)
	if (!query) return
	if (query.queue !== undefined) validateQueueName(query.queue)
	if (query.task !== undefined && !/^[a-z][a-z0-9_.-]{0,127}$/iu.test(query.task)) {
		throw new Error('Jobs schedule query task must be a safe identifier')
	}
	if (query.enabled !== undefined && typeof query.enabled !== 'boolean') {
		throw new Error('Jobs schedule query enabled must be boolean')
	}
}

export function snapshotScheduleQuery(query: ScheduleQuery | undefined): ScheduleQuery | undefined {
	if (query === undefined) return undefined
	const snapshot = snapshotJobsOptions<ScheduleQuery>(
		query, new Set(['queue', 'enabled', 'task', 'limit', 'offset']), 'Jobs schedule query'
	)
	validateStableScheduleQuery(snapshot)
	return snapshot
}

export function validateScheduleQuery(query: ScheduleQuery | undefined): void { void snapshotScheduleQuery(query) }

export const matchesRunQuery = (run: InternalRun, query?: RunQuery): boolean =>
	(!query?.queue || run.queue === query.queue) &&
	(!query?.task || run.task === query.task) &&
	(!query?.scheduleId || run.scheduleId === query.scheduleId) &&
	(!query?.status || (Array.isArray(query.status) ? query.status.includes(run.status) : run.status === query.status))

export const matchesScheduleQuery = (schedule: StoredSchedule, query?: ScheduleQuery): boolean =>
	(!query?.queue || schedule.queue === query.queue) &&
	(!query?.task || schedule.task === query.task) &&
	(query?.enabled === undefined || Boolean(schedule.enabled !== false) === query.enabled)

export const paginate = <T>(items: T[], offset = 0, limit = 100): T[] =>
	items.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(1_000, Math.max(0, limit)))
