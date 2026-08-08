import type {JobPayload, ScheduleDefinition, SchedulePolicy} from '@ooopsstudio/core/contracts/jobs'

import {
	boundedString,
	failDefinition,
	readPlainRecord,
	snapshotJsonValue
} from './definition-input'

const SCHEDULE_KEYS = new Set(['policy', 'payload', 'queue', 'startAt', 'endAt', 'enabled'])
const POLICY_KEYS = new Set(['misfire', 'overlap', 'timezone'])
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const MISFIRE_POLICIES = new Set(['skip', 'fire-once', 'catch-up'])
const OVERLAP_POLICIES = new Set(['allow', 'skip', 'queue'])
const MAX_JOBS_TIMESTAMP = 99_999_999_999_999

export interface ScheduleOptions {
	readonly policy?: SchedulePolicy
	readonly payload?: JobPayload
	readonly queue?: string
	readonly startAt?: number
	readonly endAt?: number
	readonly enabled?: boolean
}

function optionalTimestamp(value: unknown, code: string): number | undefined {
	if (value === undefined) return undefined
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_JOBS_TIMESTAMP) failDefinition(code)
	return value as number
}

function validateCronField(input: string, minimum: number, maximum: number): void {
	for (const part of input.split(',')) {
		const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part)
		if (!match) failDefinition('SDK_JOB_CRON_INVALID')
		const parsed = match as RegExpExecArray
		const base = parsed[1] as string
		const step = parsed[2] === undefined ? 1 : Number(parsed[2])
		if (!Number.isSafeInteger(step) || step < 1) failDefinition('SDK_JOB_CRON_INVALID')
		const [start, end] = base === '*'
			? [minimum, maximum]
			: base.includes('-')
				? base.split('-').map(Number) as [number, number]
				: [Number(base), parsed[2] === undefined ? Number(base) : maximum]
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < minimum || end > maximum || start > end) {
			failDefinition('SDK_JOB_CRON_INVALID')
		}
	}
}

function validateCronExpression(value: unknown): string {
	const cron = boundedString(value, 'SDK_JOB_CRON_INVALID', 256)
	const fields = cron.trim().split(/\s+/u)
	if (fields.length !== 5) failDefinition('SDK_JOB_CRON_INVALID')
	validateCronField(fields[0] as string, 0, 59)
	validateCronField(fields[1] as string, 0, 23)
	validateCronField(fields[2] as string, 1, 31)
	validateCronField(fields[3] as string, 1, 12)
	validateCronField(fields[4] as string, 0, 6)
	return fields.join(' ')
}

function validateTimezone(value: unknown): string {
	const timezone = boundedString(value, 'SDK_JOB_TIMEZONE_INVALID', 128)
	try { new Intl.DateTimeFormat('en-US', {timeZone: timezone}).format(0) } catch { return failDefinition('SDK_JOB_TIMEZONE_INVALID') }
	return timezone
}

function snapshotPolicy(value: unknown): SchedulePolicy | undefined {
	if (value === undefined) return undefined
	const input = readPlainRecord(value, 'SDK_JOB_SCHEDULE_POLICY_INVALID', POLICY_KEYS)
	if (!MISFIRE_POLICIES.has(input.misfire as string)) failDefinition('SDK_JOB_MISFIRE_POLICY_INVALID')
	if (!OVERLAP_POLICIES.has(input.overlap as string)) failDefinition('SDK_JOB_OVERLAP_POLICY_INVALID')
	return Object.freeze({
		misfire: input.misfire as SchedulePolicy['misfire'],
		overlap: input.overlap as SchedulePolicy['overlap'],
		...(input.timezone === undefined ? {} : {timezone: validateTimezone(input.timezone)})
	})
}

function snapshotOptions(rawOptions: ScheduleOptions): Readonly<ScheduleOptions> {
	const options = readPlainRecord(rawOptions, 'SDK_JOB_SCHEDULE_OPTIONS_INVALID', SCHEDULE_KEYS)
	if (options.enabled !== undefined && typeof options.enabled !== 'boolean') failDefinition('SDK_JOB_ENABLED_INVALID')
	const startAt = optionalTimestamp(options.startAt, 'SDK_JOB_START_INVALID')
	const endAt = optionalTimestamp(options.endAt, 'SDK_JOB_END_INVALID')
	if (startAt !== undefined && endAt !== undefined && startAt > endAt) failDefinition('SDK_JOB_SCHEDULE_RANGE_INVALID')
	const payload = options.payload === undefined ? undefined : snapshotJsonValue(
		readPlainRecord(options.payload, 'SDK_JOB_PAYLOAD_INVALID'),
		{
			allowUndefined: true, code: 'SDK_JOB_PAYLOAD_INVALID', maxArrayLength: 256, maxBytes: 262_144, maxDepth: 16,
			maxEntries: 256, maxKeyLength: 128, maxNodes: 4_096, maxStringLength: 65_536
		}
	) as JobPayload
	const policy = snapshotPolicy(options.policy)
	return Object.freeze({
		...(policy === undefined ? {} : {policy}),
		...(payload === undefined ? {} : {payload}),
		...(options.queue === undefined ? {} : {queue: boundedString(options.queue, 'SDK_JOB_QUEUE_INVALID', 128, RESOURCE_PATTERN)}),
		...(startAt === undefined ? {} : {startAt}),
		...(endAt === undefined ? {} : {endAt}),
		...(options.enabled === undefined ? {} : {enabled: options.enabled as boolean})
	})
}

export function cronSchedule(
	id: string,
	cron: string,
	task: string,
	options: ScheduleOptions = {}
): ScheduleDefinition {
	const snapshot = snapshotOptions(options)
	return Object.freeze({
		...snapshot,
		id: boundedString(id, 'SDK_JOB_SCHEDULE_ID_INVALID', 128, RESOURCE_PATTERN),
		kind: 'cron',
		cron: validateCronExpression(cron),
		task: boundedString(task, 'SDK_JOB_TASK_INVALID', 128, RESOURCE_PATTERN)
	})
}

export function intervalSchedule(
	id: string,
	intervalMs: number,
	task: string,
	options: ScheduleOptions = {}
): ScheduleDefinition {
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
		failDefinition('SDK_JOB_INTERVAL_INVALID')
	}
	const snapshot = snapshotOptions(options)
	return Object.freeze({
		...snapshot,
		id: boundedString(id, 'SDK_JOB_SCHEDULE_ID_INVALID', 128, RESOURCE_PATTERN),
		kind: 'interval',
		intervalMs,
		task: boundedString(task, 'SDK_JOB_TASK_INVALID', 128, RESOURCE_PATTERN)
	})
}
