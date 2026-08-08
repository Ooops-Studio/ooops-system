import {describe, expect, it} from 'vitest'

import {getNextCronOccurrence, getNextScheduleTime, getNextScheduleTimeAfterTrigger, validateCronExpression} from '../../../src/jobs/utils/cron'

describe('jobs cron', () => {
	it('supports ranges, steps, calendar matching and leap years', () => {
		const start = Date.UTC(2026, 0, 1, 10, 0)
		expect(new Date(getNextCronOccurrence('*/10 10-11 * * 4', start)).toISOString()).toBe('2026-01-01T10:10:00.000Z')
		expect(new Date(getNextCronOccurrence('0 0 1 * 1', Date.UTC(2026, 0, 6))).toISOString()).toBe('2026-01-12T00:00:00.000Z')
		expect(new Date(getNextCronOccurrence('0 0 29 2 *', Date.UTC(2025, 2, 1))).toISOString()).toBe('2028-02-29T00:00:00.000Z')
		expect(new Date(getNextCronOccurrence('5/15 * * * *', Date.UTC(2026, 0, 1, 0, 6))).toISOString()).toBe('2026-01-01T00:20:00.000Z')
		expect(new Date(getNextCronOccurrence('0 0 31 2 1', Date.UTC(2026, 0, 31))).toISOString())
			.toBe('2026-02-02T00:00:00.000Z')
	})

	it('validates expressions and impossible calendar dates', () => {
		const now = Date.UTC(2026, 0, 1)
		for (const cron of ['* * *', 'bad * * * *', '*/0 * * * *', '1-0 * * * *', '* 24 * * *']) {
			expect(() => getNextCronOccurrence(cron, now)).toThrow()
		}
		expect(() => getNextCronOccurrence('0 0 31 2 *', now)).toThrow('Unable to compute')
		expect(() => validateCronExpression('0 0 31 2 *')).toThrow('Unable to compute')
		expect(() => getNextCronOccurrence('* * * * *', Number.NaN)).toThrow('supported date range')
		expect(() => getNextCronOccurrence('* * * * *', Number.POSITIVE_INFINITY)).toThrow('supported date range')
		expect(() => getNextCronOccurrence('* * * * *', 8_640_000_000_000_001)).toThrow('supported date range')
	})

	it('handles schedule windows, defaults and timezone', () => {
		expect(getNextScheduleTime({id: 'default', task: 'task', kind: 'interval'}, 500)).toBe(60_500)
		expect(getNextScheduleTime({id: 'window', task: 'task', kind: 'interval', intervalMs: Number.NaN, startAt: 1_000, endAt: 62_000}, 500)).toBe(61_000)
		expect(getNextScheduleTime({id: 'expired', task: 'task', kind: 'cron', cron: '* * * * *', endAt: 1}, 2)).toBeUndefined()
		expect(getNextScheduleTime({id: 'missing', task: 'task', kind: 'cron'}, 0)).toBeUndefined()
		expect(getNextScheduleTime({id: 'ended', task: 'task', kind: 'interval', intervalMs: 100, endAt: 50}, 0)).toBeUndefined()
		expect(getNextScheduleTime({id: 'tz', task: 'task', kind: 'cron', cron: '0 1 * * *', policy: {misfire: 'fire-once', overlap: 'queue', timezone: 'UTC'}}, Date.UTC(2026, 0, 1))).toBe(Date.UTC(2026, 0, 1, 1))
		expect(getNextCronOccurrence('0 12 * * *', Date.UTC(2026, 0, 1, 9), 'Europe/Athens')).toBe(Date.UTC(2026, 0, 1, 10))
	})

	it('preserves interval cadence after delayed trigger processing', () => {
		const schedule = {id: 'interval', task: 'task', kind: 'interval' as const, intervalMs: 10}
		const maximumJobsTimestamp = 99_999_999_999_999
		expect(getNextScheduleTimeAfterTrigger(schedule, 10, 25)).toBe(30)
		expect(getNextScheduleTimeAfterTrigger({...schedule, endAt: 29}, 10, 25)).toBeUndefined()
		expect(getNextScheduleTime({...schedule, intervalMs: 10}, Number.MAX_SAFE_INTEGER - 1)).toBeUndefined()
		expect(getNextScheduleTime(schedule, maximumJobsTimestamp - 5)).toBeUndefined()
		expect(getNextScheduleTime({
			id: 'cron-limit', task: 'task', kind: 'cron', cron: '* * * * *'
		}, maximumJobsTimestamp - 1)).toBeUndefined()
		expect(getNextScheduleTimeAfterTrigger(schedule, maximumJobsTimestamp - 10, maximumJobsTimestamp))
			.toBeUndefined()
		expect(getNextScheduleTimeAfterTrigger({id: 'cron', task: 'task', kind: 'cron'}, 0, 0)).toBeUndefined()
		expect(getNextScheduleTimeAfterTrigger({
			id: 'cron', task: 'task', kind: 'cron', cron: '* * * * *', endAt: 1
		}, 0, 0)).toBeUndefined()
		expect(getNextScheduleTimeAfterTrigger({...schedule, intervalMs: 0}, 0, 0)).toBeUndefined()
		expect(getNextScheduleTimeAfterTrigger({...schedule, intervalMs: Number.MAX_SAFE_INTEGER}, 1, Number.MAX_SAFE_INTEGER - 1))
			.toBeUndefined()
	})
})
