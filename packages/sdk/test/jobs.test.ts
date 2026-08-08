import {describe, expect, it} from 'vitest'

import {cronSchedule, intervalSchedule} from '../src/jobs'

describe('jobs sdk', () => {
	it('creates deeply immutable validated schedules', () => {
		const payload = {document: {id: 'one'}}
		const schedule = intervalSchedule('poll', 1_000, 'send', {
			queue: 'workers', payload, policy: {misfire: 'skip', overlap: 'queue'}
		})
		payload.document.id = 'changed'
		expect(schedule).toMatchObject({id: 'poll', kind: 'interval', intervalMs: 1_000, task: 'send', queue: 'workers'})
		expect(schedule.payload).toEqual({document: {id: 'one'}})
		expect(Object.isFrozen(schedule)).toBe(true)
		expect(Object.isFrozen(schedule.payload?.document)).toBe(true)
		expect(Object.isFrozen(schedule.policy)).toBe(true)
	})

	it('rejects reserved option overrides from untyped callers', () => {
		expect(() => cronSchedule('nightly', '0 0 * * *', 'send', {id: 'override'} as never))
			.toThrow('SDK_JOB_SCHEDULE_OPTIONS_INVALID')
		expect(() => intervalSchedule('poll', 1_000, 'send', {kind: 'cron'} as never))
			.toThrow('SDK_JOB_SCHEDULE_OPTIONS_INVALID')
		expect(() => intervalSchedule('poll', 1_000, 'send', {intervalMs: 1} as never))
			.toThrow('SDK_JOB_SCHEDULE_OPTIONS_INVALID')
	})

	it('validates schedule identity, timing and policy fields', () => {
		expect(() => cronSchedule('nightly', 'not-a-cron', 'send')).toThrow('SDK_JOB_CRON_INVALID')
		expect(() => cronSchedule('nightly', '60 0 * * *', 'send')).toThrow('SDK_JOB_CRON_INVALID')
		expect(() => cronSchedule('nightly', '0 0 * * * *', 'send')).toThrow('SDK_JOB_CRON_INVALID')
		expect(() => intervalSchedule('poll', 0, 'send')).toThrow('SDK_JOB_INTERVAL_INVALID')
		expect(() => intervalSchedule('poll', 1_000, 'send', {startAt: 2, endAt: 1}))
			.toThrow('SDK_JOB_SCHEDULE_RANGE_INVALID')
		expect(() => intervalSchedule('poll', 1_000, 'send', {
			policy: {misfire: 'invalid', overlap: 'queue'} as never
		})).toThrow('SDK_JOB_MISFIRE_POLICY_INVALID')
		expect(() => intervalSchedule('poll', 1_000, 'send', {
			policy: {misfire: 'skip', overlap: 'queue', timezone: 'Not/A-Timezone'}
		})).toThrow('SDK_JOB_TIMEZONE_INVALID')
	})

	it('preserves only contract-valid top-level undefined payload values', () => {
		const schedule = intervalSchedule('poll', 1_000, 'send', {payload: {optional: undefined}})
		expect(schedule.payload).toHaveProperty('optional', undefined)
		expect(() => intervalSchedule('poll', 1_000, 'send', {
			payload: {nested: {optional: undefined}}
		} as never)).toThrow('SDK_JOB_PAYLOAD_INVALID')
		expect(() => intervalSchedule('poll', 1_000, 'send', {
			payload: {items: [undefined]}
		} as never)).toThrow('SDK_JOB_PAYLOAD_INVALID')
		for (const payload of [null, 'payload', 1, []]) {
			expect(() => intervalSchedule('poll', 1_000, 'send', {payload} as never))
				.toThrow('SDK_JOB_PAYLOAD_INVALID')
		}
	})
})
