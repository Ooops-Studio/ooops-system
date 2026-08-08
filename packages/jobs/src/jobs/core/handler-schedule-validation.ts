import type {ScheduleDefinition} from '@ooopsstudio/core/contracts/jobs'

import type {StoredSchedule} from '../types/backend'
import {validateCronExpression} from '../utils/cron'

import {
	assertStableRecord,
	MAX_JOBS_TIMESTAMP,
	snapshotJobPayload,
	snapshotStableRecord,
	validateJobPayload
} from './handler-helpers'

const MAX_TIMER_MS = 2_147_483_647
const SCHEDULE_FIELDS = new Set([
	'id', 'task', 'kind', 'cron', 'intervalMs', 'policy', 'payload', 'queue', 'startAt', 'endAt',
	'enabled', 'nextRunAt', 'lastTriggeredAt'
])
const SCHEDULE_POLICY_FIELDS = new Set(['misfire', 'overlap', 'timezone'])

export function snapshotScheduleDefinition(definition: unknown): ScheduleDefinition {
	const snapshot = snapshotStableRecord<ScheduleDefinition>(definition, 'Schedule definition', SCHEDULE_FIELDS)
	if (snapshot.policy !== undefined) {
		snapshot.policy = snapshotStableRecord<NonNullable<ScheduleDefinition['policy']>>(
			snapshot.policy, 'Schedule policy', SCHEDULE_POLICY_FIELDS
		)
	}
	if (snapshot.payload !== undefined) snapshot.payload = snapshotJobPayload(snapshot.payload)
	validateScheduleDefinition(snapshot)
	return snapshot
}

export function validateScheduleDefinition(definition: ScheduleDefinition): void {
	assertStableRecord(definition, 'Schedule definition', SCHEDULE_FIELDS)
	if (!/^[a-z][a-z0-9_.-]{0,127}$/i.test(definition.id)) throw new Error('Schedule id must be a safe identifier')
	if (!/^[a-z][a-z0-9_.-]{0,127}$/i.test(definition.task)) throw new Error('Schedule task must be a safe identifier')
	if (definition.kind !== 'cron' && definition.kind !== 'interval') throw new Error(`Schedule ${definition.id} requires a valid kind`)
	if (definition.kind === 'cron' && (typeof definition.cron !== 'string' || definition.cron.trim().length === 0 || definition.cron.length > 256)) throw new Error(`Schedule ${definition.id} requires cron with at most 256 characters`)
	if (definition.kind === 'cron') validateCronExpression(definition.cron!)
	if (definition.kind === 'interval' && (!Number.isSafeInteger(definition.intervalMs) || (definition.intervalMs ?? 0) <= 0 || (definition.intervalMs ?? 0) > MAX_TIMER_MS)) throw new Error(`Schedule ${definition.id} requires intervalMs between 1 and 2147483647`)
	if ((definition.kind === 'cron' && definition.intervalMs !== undefined)
		|| (definition.kind === 'interval' && definition.cron !== undefined)) {
		throw new Error(`Schedule ${definition.id} mixes cron and interval configuration`)
	}
	if (definition.queue !== undefined && !/^[a-z][a-z0-9_.-]{0,63}$/iu.test(definition.queue)) throw new Error('Schedule queue must be a safe identifier')
	if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') throw new Error('Schedule enabled must be boolean')
	if (definition.payload !== undefined && (!definition.payload || typeof definition.payload !== 'object' || Array.isArray(definition.payload))) throw new Error('Schedule payload must be an object')
	if (definition.payload !== undefined) validateJobPayload(definition.payload)
	if (definition.startAt !== undefined && (!Number.isSafeInteger(definition.startAt) || definition.startAt < 0 || definition.startAt > MAX_JOBS_TIMESTAMP)) throw new Error('Schedule startAt must be a supported non-negative timestamp')
	if (definition.endAt !== undefined && (!Number.isSafeInteger(definition.endAt) || definition.endAt < 0 || definition.endAt > MAX_JOBS_TIMESTAMP)) throw new Error('Schedule endAt must be a supported non-negative timestamp')
	if (definition.endAt !== undefined && definition.startAt !== undefined && definition.endAt < definition.startAt) throw new Error('Schedule endAt must not precede startAt')
	if (definition.policy !== undefined) {
		assertStableRecord(definition.policy, 'Schedule policy', SCHEDULE_POLICY_FIELDS)
		const overlap = String(definition.policy.overlap)
		if (overlap === 'replace') throw new Error('JOBS_SCHEDULE_POLICY_UNSUPPORTED')
		if (!['skip', 'fire-once', 'catch-up'].includes(definition.policy.misfire)
			|| !['allow', 'skip', 'queue'].includes(overlap)) {
			throw new Error('Schedule policy values are invalid')
		}
		if (definition.policy.timezone !== undefined) {
			if (typeof definition.policy.timezone !== 'string' || definition.policy.timezone.length < 1 || definition.policy.timezone.length > 64) throw new Error('Schedule timezone must contain 1 to 64 characters')
			try { new Intl.DateTimeFormat('en-US', {timeZone: definition.policy.timezone}) } catch { throw new Error('Schedule timezone is invalid') }
		}
	}
}

export function validateStoredSchedule(value: unknown): asserts value is StoredSchedule {
	try { validateScheduleDefinition(value as ScheduleDefinition) } catch(error) {
		if (error instanceof Error && error.message === 'JOBS_SCHEDULE_POLICY_UNSUPPORTED') throw error
		throw new Error('Jobs backend returned an invalid schedule')
	}
	const schedule = value as StoredSchedule
	for (const timestamp of [schedule.nextRunAt, schedule.lastTriggeredAt]) {
		if (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_JOBS_TIMESTAMP)) {
			throw new Error('Jobs backend returned invalid schedule timestamps')
		}
	}
	if (schedule.nextRunAt !== undefined && schedule.endAt !== undefined && schedule.nextRunAt > schedule.endAt) {
		throw new Error('Jobs backend returned an inconsistent schedule window')
	}
	if (schedule.nextRunAt !== undefined && schedule.startAt !== undefined && schedule.nextRunAt < schedule.startAt) {
		throw new Error('Jobs backend returned an inconsistent schedule window')
	}
}
