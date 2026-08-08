import {describe, expect, it} from 'vitest'

import {
	decodeAppendResult,
	decodeDeadLetter,
	decodeDeadLetters,
	decodeProviderBoolean,
	decodeRun,
	decodeRuns,
	decodeSchedule,
	decodeSchedules,
	parseProviderJson,
	validateAppendInput,
	validateBoundedCount,
	validateCancelMutation,
	validateClaimRequest,
	validateCleanupRequest,
	validateDeadLetterLimit,
	validateLeaseMutation,
	validateQueueStatsRequest,
	validateRecoveryRequest,
	validateStats,
	validateTriggerRequest
} from '../../../src/jobs/features/backends/backend-validation'

const run = (id = 'run') => ({
	id, task: 'task', queue: 'queue', payload: {}, status: 'queued' as const,
	createdAt: 0, updatedAt: 0, runAt: 0, priority: 0, attempt: 0, maxAttempts: 1,
	retryPolicy: {attempts: 1, baseDelayMs: 1}
})
const schedule = (id = 'schedule') => ({id, task: 'task', kind: 'interval' as const, intervalMs: 1})
const dead = (id = 'dead') => ({id, runId: 'run', queue: 'queue', task: 'task', reason: 'failed', attempts: 1, failedAt: 1})
const stats = (queue = 'queue') => ({queue, queued: 0, running: 0, retryable: 0, deadLettered: 0, completed: 0, failed: 0, cancelled: 0, paused: false, lagMs: 0})

describe('jobs backend validation', () => {
	it('decodes null, string, object, and duplicate provider collections', () => {
		expect(decodeRun(null)).toBeUndefined()
		expect(decodeSchedule(null)).toBeUndefined()
		expect(decodeDeadLetter(null)).toBeUndefined()
		expect(decodeRun(JSON.stringify(run()))).toEqual(run())
		expect(decodeSchedule(JSON.stringify(schedule()))).toEqual(schedule())
		expect(decodeDeadLetter(JSON.stringify(dead()))).toEqual(dead())
		expect(decodeRuns(JSON.stringify([run(), JSON.stringify(run('second'))]))).toHaveLength(2)
		expect(decodeSchedules(JSON.stringify([schedule(), JSON.stringify(schedule('second'))]))).toHaveLength(2)
		expect(decodeDeadLetters(JSON.stringify([dead(), JSON.stringify(dead('second'))]))).toHaveLength(2)
		for (const [decode, value] of [
			[decodeRuns, JSON.stringify([run(), run()])],
			[decodeSchedules, JSON.stringify([schedule(), schedule()])],
			[decodeDeadLetters, JSON.stringify([dead(), dead()])]
		] as const) expect(() => decode(value)).toThrow('duplicate')
		expect(() => decodeRuns('{}')).toThrow('invalid run list')
		expect(() => decodeSchedules('{}')).toThrow('invalid schedule list')
		expect(() => decodeDeadLetters('{}')).toThrow('invalid dead-letter list')
		expect(() => decodeDeadLetter(JSON.stringify({...dead(), failedAt: -1}))).toThrow('dead-letter fields')
		expect(() => parseProviderJson(1 as never, 'value')).toThrow('invalid value JSON')
		expect(() => parseProviderJson('{', 'value')).toThrow('invalid value JSON')
	})

	it('validates every backend request boundary and overflow branch', () => {
		const validRun = run()
		validateAppendInput(validRun, {key: 'key', checksum: 'sum', expiresAt: 1})
		for (const stale of [{...validRun, startedAt: 0}, {...validRun, error: 'old'}]) {
			expect(() => validateAppendInput(stale, undefined)).toThrow('clean new queued run')
		}
		for (const idempotency of [
			{key: '', checksum: 'sum', expiresAt: 1},
			{key: 'bad\nkey', checksum: 'sum', expiresAt: 1},
			{key: 'bad\ud800key', checksum: 'sum', expiresAt: 1},
			{key: 'key', checksum: '', expiresAt: 1},
			{key: 'key', checksum: 'sum', expiresAt: -1}
		]) expect(() => validateAppendInput(validRun, idempotency)).toThrow('idempotency')

		const claim = {now: 0, workerId: 'worker', limit: 1, maxConcurrentRuns: 1_024, leaseMs: 1}
		validateClaimRequest({...claim, allowedTasks: ['task'], concurrencyByTask: {task: 1}})
		for (const value of [null, {...claim, now: -1}, {...claim, limit: 0},
			{...claim, maxConcurrentRuns: 0}, {...claim, maxConcurrentRuns: 1_025}, {...claim, leaseMs: 0},
			{...claim, now: Number.MAX_SAFE_INTEGER, leaseMs: 1}, {...claim, workerId: ''},
			{...claim, allowedTasks: ['bad task']}, {...claim, allowedTasks: ['task', 'task']},
			{...claim, concurrencyByTask: {'bad task': 1}}, {...claim, concurrencyByTask: {task: 0}}]) {
			expect(() => validateClaimRequest(value as never)).toThrow()
		}

		const trigger = {now: 0, maxCatchUp: 1, createRun: () => run()}
		validateTriggerRequest(trigger)
		validateTriggerRequest({
			...trigger, allowedTasks: ['task'],
			allowedMisfire: ['fire-once'], allowedOverlap: ['queue', 'skip']
		})
		for (const value of [null, {...trigger, now: -1}, {...trigger, maxCatchUp: 0},
			{...trigger, misfireGraceMs: -1}, {...trigger, terminalExpiresAt: -1}, {...trigger, createRun: 1}]) {
			expect(() => validateTriggerRequest(value as never)).toThrow('trigger request')
		}
		for (const value of [
			{...trigger, allowedMisfire: []}, {...trigger, allowedMisfire: ['unknown']},
			{...trigger, allowedOverlap: ['queue', 'queue']}, {...trigger, allowedOverlap: ['unknown']}
		]) expect(() => validateTriggerRequest(value as never)).toThrow('policy constraints')
		for (const value of [
			{...trigger, allowedTasks: ['bad task']}, {...trigger, allowedTasks: ['task', 'task']}
		]) expect(() => validateTriggerRequest(value as never)).toThrow('allowed tasks')
		expect(() => validateLeaseMutation('run', 'token', 1, 0)).not.toThrow()
		expect(() => validateLeaseMutation('run', 'token', 0, 0)).toThrow('lease timestamps')
		expect(() => validateCancelMutation('run', undefined, undefined, 0, 1)).not.toThrow()
		expect(() => validateCancelMutation('run', undefined, undefined, -1, undefined)).toThrow('cancellation timestamps')
		expect(() => validateRecoveryRequest(0, 0)).not.toThrow()
		expect(() => validateRecoveryRequest(-1, 0)).toThrow('stale recovery')
		expect(() => validateCleanupRequest(0, 0)).not.toThrow()
		expect(() => validateCleanupRequest(0, 10_001)).toThrow('cleanup')
		expect(() => validateDeadLetterLimit(10_000)).not.toThrow()
		expect(() => validateDeadLetterLimit(10_001)).toThrow('dead-letter limit')
		expect(() => validateQueueStatsRequest('queue', 0)).not.toThrow()
		expect(() => validateQueueStatsRequest('bad queue', 0)).toThrow('safe identifier')
		expect(() => validateQueueStatsRequest(undefined, -1)).toThrow('timestamp')
	})

	it('validates provider result discriminators, counts, booleans, and stats', () => {
		expect(decodeAppendResult(JSON.stringify({run: run(), existing: false}))).toMatchObject({existing: false})
		for (const value of [null, [], {run: run()}, {run: run(), existing: 'yes'}]) {
			expect(() => decodeAppendResult(JSON.stringify(value))).toThrow('append result')
		}
		expect(validateBoundedCount('2', 2, 'count')).toBe(2)
		expect(validateBoundedCount(1, 2, 'count')).toBe(1)
		for (const value of ['-1', 3, 1.5]) expect(() => validateBoundedCount(value, 2, 'count')).toThrow('invalid count')
		expect(decodeProviderBoolean('true', 'boolean')).toBe(true)
		expect(decodeProviderBoolean(true, 'boolean')).toBe(true)
		expect(decodeProviderBoolean('false', 'boolean')).toBe(false)
		expect(decodeProviderBoolean(false, 'boolean')).toBe(false)
		expect(() => decodeProviderBoolean(1, 'boolean')).toThrow('invalid boolean')
		expect(validateStats([stats(), stats('other')])).toHaveLength(2)
		expect(() => validateStats({})).toThrow('queue stats')
		expect(() => validateStats([stats(), stats()])).toThrow('duplicate queue stats')
	})
})
