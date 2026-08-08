import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {promisify} from 'node:util'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {createRedisJobsBackend} from '../../../src/jobs/features/backends/redis'
import {migrateRedisJobsSnapshot} from '../../../src/jobs/features/backends/redis-migration'
import type {JobsRedisPort as RedisPort, StoredDeadLetter, StoredJobRun, StoredSchedule} from '../../../src/jobs/types/backend'

const execute = promisify(execFile)
const container = process.env.JOBS_REDIS_DOCKER_CONTAINER
const live = container ? describe : describe.skip

async function redisCli(...arguments_: string[]): Promise<unknown> {
	const {stdout} = await execute('docker', [
		'exec', container!, 'redis-cli', '--json', ...arguments_
	], {maxBuffer: 32 * 1024 * 1024})
	return JSON.parse(stdout.trim()) as unknown
}

const redis = {
	async ping() { return await redisCli('PING') === 'PONG' },
	async eval<T>(script: string, keys: readonly string[], args: readonly (string | number)[] = []) {
		return await redisCli(
			'EVAL', script, String(keys.length), ...keys, ...args.map(String)
		) as T
	}
} as unknown as RedisPort

const queuedRun = (id: string, priority = 0): StoredJobRun => ({
	id, task: 'task', queue: 'default', payload: {id}, status: 'queued',
	createdAt: 1, updatedAt: 1, runAt: 1, priority, attempt: 0, maxAttempts: 2,
	retryPolicy: {attempts: 2, baseDelayMs: 10}
})

async function clearPrefix(prefix: string): Promise<void> {
	await redisCli(
		'EVAL', "local c='0';repeat local r=redis.call('SCAN',c,'MATCH',ARGV[1],'COUNT',1000);c=r[1];if #r[2]>0 then redis.call('DEL',unpack(r[2])) end until c=='0';return 1",
		'0', `${prefix}*`
	)
}

live('native Redis Jobs backend', () => {
	const namespace = `jobs-live-${process.pid}-${Date.now()}`
	const keyPrefix = `jobs:{${createHash('sha256').update(namespace).digest('hex').slice(0, 32)}}`
	const backend = createRedisJobsBackend({redis, namespace})

	beforeAll(async() => { await expect(backend.runs.getRun('compatibility-probe')).resolves.toBeUndefined() })
	afterAll(async() => { await clearPrefix(keyPrefix) })

	it('atomically enqueues, orders and prevents duplicate concurrent claims', async() => {
		await backend.runs.appendRun(queuedRun('low'))
		await backend.runs.appendRun(queuedRun('high', 10), {
			key: 'idempotency', checksum: 'a'.repeat(64), expiresAt: 1_000
		})
		expect((await backend.runs.appendRun(queuedRun('duplicate'), {
			key: 'idempotency', checksum: 'a'.repeat(64), expiresAt: 1_000
		})).run.id).toBe('high')

		const request = {now: 2, limit: 1, maxConcurrentRuns: 1, leaseMs: 1_000}
		const [left, right] = await Promise.all([
			backend.runs.claimDueRuns({...request, workerId: 'worker-a'}),
			backend.runs.claimDueRuns({...request, workerId: 'worker-b'})
		])
		const claims = [...left, ...right]
		expect(claims).toHaveLength(1)
		expect(claims[0]?.id).toBe('high')
		expect(new Set(claims.map((run) => run.leaseToken)).size).toBe(1)
	})

	it('quarantines poisoned runnable records without blocking healthy claims', async() => {
		const isolatedNamespace = `${namespace}-exhausted-retryable`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		let loseDiscardResponse = false
		const flakyRedis = {
			async ping() { return redis.ping() },
			async eval<T>(script: string, keys: readonly string[], args: readonly (string | number)[] = []) {
				const result = await redis.eval<T>(script, keys, args)
				if (loseDiscardResponse && args[0] === 'discardClaim') {
					loseDiscardResponse = false
					throw new Error('discard response lost')
				}
				return result
			}
		} as RedisPort
		const isolated = createRedisJobsBackend({redis: flakyRedis, namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun({...queuedRun('repaired-metadata', 12)})
			await isolated.runs.appendRun({...queuedRun('invalid-routing', 11)})
			await isolated.runs.appendRun({...queuedRun('poisoned-retryable', 10)})
			await isolated.runs.appendRun({...queuedRun('invalid-queued', 9)})
			await isolated.runs.appendRun({...queuedRun('invalid-retry-policy', 8)})
			const healthyChecksum = 'b'.repeat(64)
			await isolated.runs.appendRun({
				...queuedRun('healthy-after-poison'),
				retryPolicy: {
					attempts: 2, baseDelayMs: 10, maxDelayMs: 100,
					backoff: {kind: 'exponential', factor: 2}, jitter: 'bounded'
				},
				idempotencyKey: 'healthy-idempotency', idempotencyChecksum: healthyChecksum,
				idempotencyExpiresAt: 1_000,
				traceContext: {
					traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
					tracestate: 'vendor=value', baggage: 'tenant=healthy'
				}
			}, {key: 'healthy-idempotency', checksum: healthyChecksum, expiresAt: 1_000})
			const poisoned = {
				...queuedRun('poisoned-retryable', 10), status: 'retryable', attempt: 2
			}
			await redisCli(
				'HSET', `${isolatedPrefix}:runs`, poisoned.id, JSON.stringify(poisoned)
			)
			const invalidQueued = {...queuedRun('invalid-queued', 9), attempt: 1}
			await redisCli(
				'HSET', `${isolatedPrefix}:runs`, invalidQueued.id, JSON.stringify(invalidQueued)
			)
			const invalidRetryPolicy = {
				...queuedRun('invalid-retry-policy', 8),
				retryPolicy: {attempts: 2, baseDelayMs: 10, maxDelayMs: -1}
			}
			await redisCli(
				'HSET', `${isolatedPrefix}:runs`, invalidRetryPolicy.id, JSON.stringify(invalidRetryPolicy)
			)
			await redisCli(
				'HSET', `${isolatedPrefix}:runs`, 'invalid-routing', JSON.stringify({
					id: 'invalid-routing', status: 'queued', runAt: 1, priority: 11
				})
			)
			await redisCli(
				'HSET', `${isolatedPrefix}:runnable-meta-v2`, 'repaired-metadata',
				JSON.stringify({id: 'repaired-metadata'})
			)

			const claimRequest = {
				now: 2, workerId: 'healthy-worker', limit: 2,
				maxConcurrentRuns: 2, leaseMs: 1_000
			}
			loseDiscardResponse = true
			const claimed = await isolated.runs.claimDueRuns(claimRequest)

			expect(claimed.map((run) => run.id)).toEqual(['repaired-metadata', 'healthy-after-poison'])
			expect(loseDiscardResponse).toBe(false)
			expect(await redisCli('GET', `${isolatedPrefix}:running-count`)).toBe('2')
			expect(await redisCli(
				'HEXISTS', `${isolatedPrefix}:runnable-meta-v2`, 'invalid-routing'
			)).toBe(0)
			expect(await redisCli(
				'HEXISTS', `${isolatedPrefix}:runnable-meta-v2`, poisoned.id
			)).toBe(0)
			expect(await redisCli(
				'HEXISTS', `${isolatedPrefix}:runnable-meta-v2`, invalidQueued.id
			)).toBe(0)
			expect(await redisCli(
				'HEXISTS', `${isolatedPrefix}:runnable-meta-v2`, invalidRetryPolicy.id
			)).toBe(0)
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:delayed`, poisoned.id)).toBeNull()
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:delayed`, invalidQueued.id)).toBeNull()
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:delayed`, invalidRetryPolicy.id)).toBeNull()
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:delayed`, 'invalid-routing')).toBeNull()
		} finally { await clearPrefix(isolatedPrefix) }
	}, 15_000)

	it('claims only tasks allowed by a specialized worker', async() => {
		const isolatedNamespace = `${namespace}-allowed-tasks`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun({...queuedRun('foreign-task'), task: 'foreign'})
			await isolated.runs.appendRun({...queuedRun('local-task'), task: 'local'})

			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'specialized-worker', limit: 2,
				maxConcurrentRuns: 2, leaseMs: 1_000, allowedTasks: ['local']
			})

			expect(claimed.map((run) => run.id)).toEqual(['local-task'])
			await expect(isolated.runs.getRun('foreign-task')).resolves.toMatchObject({status: 'queued', attempt: 0})
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('quarantines an oversized runnable record without starving healthy claims', async() => {
		const isolatedNamespace = `${namespace}-oversized-runnable`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('oversized-runnable', 20))
			await isolated.runs.appendRun(queuedRun('healthy-after-oversized', 10))
			await redisCli('EVAL', `local p=KEYS[1];local id='oversized-runnable';local run={
				id=id,task='task',queue='default',payload={blob=string.rep('x',4*1024*1024)},
				status='queued',createdAt=1,updatedAt=1,runAt=1,priority=20,attempt=0,
				maxAttempts=2,retryPolicy={attempts=2,baseDelayMs=10}}
				redis.call('HSET',p..':runs',id,cjson.encode(run))
				redis.call('HDEL',p..':runnable-meta-v2',id);return 1`, '1', isolatedPrefix)

			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'healthy-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})

			expect(claimed.map((run) => run.id)).toEqual(['healthy-after-oversized'])
			expect(await redisCli(
				'HEXISTS', `${isolatedPrefix}:runnable-meta-v2`, 'oversized-runnable'
			)).toBe(0)
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:delayed`, 'oversized-runnable'
			)).toBeNull()
		} finally { await clearPrefix(isolatedPrefix) }
	}, 15_000)

	it('triggers only schedules allowed by a specialized worker', async() => {
		const isolatedNamespace = `${namespace}-allowed-schedule-tasks`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'a-foreign-schedule', task: 'foreign', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1
			})
			await isolated.schedules.saveSchedule({
				id: 'z-local-schedule', task: 'local', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1
			})
			await redisCli('HSET', `${isolatedPrefix}:schedules`, 'corrupt-foreign-schedule', '{')
			await redisCli('ZADD', `${isolatedPrefix}:schedule-due`, '1', 'corrupt-foreign-schedule')
			await redisCli(
				'DEL', `${isolatedPrefix}:schedule-order-v1`,
				`${isolatedPrefix}:schedule-order-v1-cursor`, `${isolatedPrefix}:schedule-order`,
				`${isolatedPrefix}:idx:schedule-task-order:foreign`,
				`${isolatedPrefix}:idx:schedule-task-order:local`
			)
			await expect(isolated.admin!.listSchedules({task: 'local'})).resolves.toHaveLength(1)
			await redisCli('DEL', `${isolatedPrefix}:idx:schedule-task-order:local`)
			expect(await redisCli(
				'ZCARD', `${isolatedPrefix}:idx:schedule-task-order:local`
			)).toBe(0)

			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1, allowedTasks: ['local'],
				createRun: (schedule, runAt) => ({
					...queuedRun(`generated-${schedule.id}`), task: schedule.task,
					queue: schedule.queue ?? 'default', scheduleId: schedule.id, runAt
				})
			})

			expect(triggered.map((result) => result.schedule.id)).toEqual(['z-local-schedule'])
			await expect(isolated.schedules.getSchedule('a-foreign-schedule')).resolves.toMatchObject({nextRunAt: 1})
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('leaves valid unsupported schedule policies claimable by another worker', async() => {
		const isolatedNamespace = `${namespace}-allowed-schedule-policies`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'a-allow-policy', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'catch-up', overlap: 'allow'}
			})
			await isolated.schedules.saveSchedule({
				id: 'z-queue-policy', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'queue'}
			})
			const createRun = (schedule: StoredSchedule, runAt: number) => ({
				...queuedRun(`generated-${schedule.id}`), scheduleId: schedule.id, runAt
			})

			const queueWorker = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1, allowedMisfire: ['fire-once'],
				allowedOverlap: ['queue'], createRun
			})
			expect(queueWorker.map((result) => result.schedule.id)).toEqual(['z-queue-policy'])
			await expect(isolated.schedules.getSchedule('a-allow-policy')).resolves.toMatchObject({nextRunAt: 1})
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:schedule-due`, 'a-allow-policy')).toBe(1)

			const allowWorker = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1, allowedMisfire: ['catch-up'],
				allowedOverlap: ['allow'], createRun
			})
			expect(allowWorker.map((result) => result.schedule.id)).toEqual(['a-allow-policy'])
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('rebuilds a lost schedule-live set before enforcing queue overlap', async() => {
		const isolatedNamespace = `${namespace}-schedule-live-drift`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'overlap-guarded', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'queue'}
			})
			await isolated.runs.appendRun({
				...queuedRun('active-for-schedule'), scheduleId: 'overlap-guarded'
			})
			expect(await redisCli(
				'GET', `${isolatedPrefix}:idx:sl2:overlap-guarded`
			)).toBe('1')
			await redisCli('DEL', `${isolatedPrefix}:idx:schedule-live:overlap-guarded`)

			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun('must-not-be-created'), scheduleId: schedule.id, runAt
				})
			})

			expect(triggered).toEqual([expect.objectContaining({runs: []})])
			expect(await redisCli(
				'SISMEMBER', `${isolatedPrefix}:idx:schedule-live:overlap-guarded`,
				'active-for-schedule'
			)).toBe(1)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('rebuilds a lost due index from canonical schedules', async() => {
		const isolatedNamespace = `${namespace}-schedule-due-drift`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'due-after-rebuild', task: 'task', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1,
				policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			expect(await redisCli('GET', `${isolatedPrefix}:sd2`)).toBe('1')
			await redisCli('DEL', `${isolatedPrefix}:schedule-due`)

			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun('generated-after-due-rebuild'), scheduleId: schedule.id, runAt
				})
			})

			expect(triggered.flatMap((result) => result.runs).map((run) => run.id))
				.toEqual(['generated-after-due-rebuild'])
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('preserves a legacy snapshot when marked native migration data has drifted', async() => {
		const isolatedNamespace = `${namespace}-migration-parity`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const legacyKey = `${isolatedNamespace}:snapshot`
		const snapshot = JSON.stringify({
			version: 1,
			data: JSON.stringify({
				runs: {'legacy-run': queuedRun('legacy-run')}, schedules: {},
				deadLetters: {}, idempotency: {}, queuePaused: []
			})
		})
		try {
			await redisCli('SET', legacyKey, snapshot)
			await redisCli('SET', `${isolatedPrefix}:native-v2`, 'migrated')
			await redisCli('HSET', `${isolatedPrefix}:runs`, 'legacy-run', JSON.stringify({
				...queuedRun('legacy-run'), task: 'wrong-task'
			}))

			await expect(migrateRedisJobsSnapshot({
				redis, namespace: isolatedNamespace, deleteLegacySnapshot: true
			})).rejects.toThrow('JOBS_NATIVE_MIGRATION_INCOMPLETE')
			expect(await redisCli('EXISTS', legacyKey)).toBe(1)

			await clearPrefix(isolatedPrefix)
			await expect(migrateRedisJobsSnapshot({
				redis, namespace: isolatedNamespace, deleteLegacySnapshot: true
			})).resolves.toMatchObject({migrated: true, runs: 1})
			expect(await redisCli('EXISTS', legacyKey)).toBe(0)
			expect(await redisCli('HEXISTS', `${isolatedPrefix}:runs`, 'legacy-run')).toBe(1)
		} finally {
			await clearPrefix(isolatedPrefix)
			await redisCli('DEL', legacyKey)
		}
	})

	it('preserves a newer legacy snapshot written after native migration verification', async() => {
		const isolatedNamespace = `${namespace}-migration-write-race`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const legacyKey = `${isolatedNamespace}:snapshot`
		const state = {
			runs: {'legacy-run': queuedRun('legacy-run')}, schedules: {},
			deadLetters: {}, idempotency: {}, queuePaused: []
		}
		const snapshot = JSON.stringify({version: 1, data: JSON.stringify(state), updatedAt: 1})
		const newerSnapshot = JSON.stringify({version: 1, data: JSON.stringify(state), updatedAt: 2})
		let injected = false
		const racingRedis: RedisPort = {
			...redis,
			async eval<T>(script, keys, arguments_ = []) {
				const result = await redis.eval!<T>(script, keys, arguments_)
				if (!injected && arguments_[0] === 'verifyMigration') {
					injected = true
					await redisCli('SET', legacyKey, newerSnapshot)
				}
				return result
			}
		}
		try {
			await redisCli('SET', legacyKey, snapshot)

			await expect(migrateRedisJobsSnapshot({
				redis: racingRedis, namespace: isolatedNamespace, deleteLegacySnapshot: true
			})).rejects.toThrow('JOBS_LEGACY_SNAPSHOT_CHANGED')

			expect(injected).toBe(true)
			expect(await redisCli('GET', legacyKey)).toBe(newerSnapshot)
			expect(await redisCli('HEXISTS', `${isolatedPrefix}:runs`, 'legacy-run')).toBe(1)
		} finally {
			await clearPrefix(isolatedPrefix)
			await redisCli('DEL', legacyKey)
		}
	})

	it('returns healthy claims when a later indexed run payload is malformed', async() => {
		const isolatedNamespace = `${namespace}-claim-corruption-isolation`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('healthy-claim', 10))
			await isolated.runs.appendRun(queuedRun('corrupt-claim', 0))
			await redisCli('HSET', `${isolatedPrefix}:runs`, 'corrupt-claim', '{')

			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'corruption-worker', limit: 2,
				maxConcurrentRuns: 2, leaseMs: 1_000
			})

			expect(claimed.map((run) => run.id)).toEqual(['healthy-claim'])
			await expect(isolated.runs.getRun('healthy-claim')).resolves.toMatchObject({status: 'running'})
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('defers queue-overlap schedules with live runs so later due schedules remain reachable', async() => {
		const isolatedNamespace = `${namespace}-schedule-fairness`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.getRun('compatibility-probe')
			expect(await redisCli('EVAL', `local p=KEYS[1]
				for i=0,99 do
					local sid=string.format('blocked-%03d',i);local rid='active-'..i
					local schedule={id=sid,task='task',kind='interval',intervalMs=1000,nextRunAt=1,
						policy={misfire='fire-once',overlap='queue'}}
					local run={id=rid,task='task',queue='default',payload={},status='running',createdAt=1,
						updatedAt=2,runAt=1,priority=1,attempt=1,maxAttempts=1,
						retryPolicy={attempts=1,baseDelayMs=0},scheduleId=sid,leaseOwner='worker',
						leaseToken='token-'..i,leaseExpiresAt=1000,lastHeartbeatAt=2}
					redis.call('HSET',p..':schedules',sid,cjson.encode(schedule))
					redis.call('ZADD',p..':schedule-due',1,sid)
					redis.call('HSET',p..':runs',rid,cjson.encode(run))
					redis.call('SADD',p..':idx:schedule-live:'..sid,rid)
					redis.call('SET',p..':idx:schedule-live-ready:'..sid,'1')
				end
				local target={id='target',task='task',kind='interval',intervalMs=1000,nextRunAt=1,
					policy={misfire='fire-once',overlap='queue'}}
				redis.call('HSET',p..':schedules','target',cjson.encode(target))
				redis.call('ZADD',p..':schedule-due',1,'target')
				return redis.call('HLEN',p..':schedules')`, '1', isolatedPrefix)).toBe(101)
			let sequence = 0
			const trigger = () => isolated.schedules.triggerDueSchedules({
				now: 3, maxCatchUp: 10,
				createRun: (schedule, runAt) => ({
					...queuedRun(`generated-${schedule.id}-${sequence++}`), runAt, createdAt: 3, updatedAt: 3,
					scheduleId: schedule.id
				})
			})
			expect((await trigger()).flatMap((result) => result.runs)).toEqual([])
			expect((await trigger()).flatMap((result) => result.runs).map((run) => run.id))
				.toEqual(['generated-target-0'])
		} finally {
			await clearPrefix(isolatedPrefix)
		}
	}, 30_000)

	it('fires a skip-misfire schedule within the polling grace window', async() => {
		const isolatedNamespace = `${namespace}-skip-grace`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'skip-grace', task: 'task', kind: 'interval', intervalMs: 1_000, nextRunAt: 1_000,
				policy: {misfire: 'skip', overlap: 'allow'}
			})
			const results = await isolated.schedules.triggerDueSchedules({
				now: 1_100, maxCatchUp: 10, misfireGraceMs: 250,
				createRun: (schedule, runAt) => ({
					...queuedRun('skip-grace-run'), runAt, createdAt: 1_100, updatedAt: 1_100,
					scheduleId: schedule.id
				})
			})
			expect(results.flatMap((result) => result.triggerTimes)).toEqual([1_000])
		} finally {
			await clearPrefix(isolatedPrefix)
		}
	})

	it('rejects a stale schedule save after its due occurrence advances', async() => {
		const isolatedNamespace = `${namespace}-schedule-cas`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			const initial: StoredSchedule = {
				id: 'schedule-cas', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1_000, policy: {misfire: 'fire-once', overlap: 'allow'}
			}
			expect(await isolated.schedules.saveSchedule(initial, null)).toBe(true)
			const expected = await isolated.schedules.getSchedule(initial.id)
			await isolated.schedules.triggerDueSchedules({
				now: 1_000, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun('schedule-cas-run'), scheduleId: schedule.id, runAt,
					createdAt: 1_000, updatedAt: 1_000
				})
			})

			expect(await isolated.schedules.saveSchedule({
				...initial, payload: {stale: true}
			}, expected!)).toBe(false)
			await expect(isolated.schedules.getSchedule(initial.id)).resolves.toMatchObject({nextRunAt: 2_000})
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('uses the final available run slot instead of rejecting a larger schedule batch', async() => {
		const isolatedNamespace = `${namespace}-schedule-capacity-prefix`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.getRun('compatibility-probe')
			expect(await redisCli(
				'EVAL',
				`local runs=KEYS[1] for i=1,9999 do local id='filler-'..i
				redis.call('HSET',runs,id,cjson.encode({id=id})) end return redis.call('HLEN',runs)`,
				'1', `${isolatedPrefix}:runs`
			)).toBe(9_999)
			for (const id of ['capacity-a', 'capacity-b']) {
				await isolated.schedules.saveSchedule({
					id, task: 'task', kind: 'interval', intervalMs: 1_000, nextRunAt: 1,
					policy: {misfire: 'fire-once', overlap: 'allow'}
				})
			}
			let sequence = 0
			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 10,
				createRun: (schedule, runAt) => ({
					...queuedRun(`capacity-generated-${sequence++}`), scheduleId: schedule.id, runAt,
					createdAt: 2, updatedAt: 2
				})
			})

			expect(triggered.flatMap((result) => result.runs)).toHaveLength(1)
			expect(await redisCli('HLEN', `${isolatedPrefix}:runs`)).toBe(10_000)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('uses the final available queue slot for a schedule prefix', async() => {
		const isolatedNamespace = `${namespace}-schedule-queue-prefix`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.getRun('compatibility-probe')
			expect(await redisCli(
				'EVAL',
				`for i=1,999 do redis.call('SADD',KEYS[1],'existing-'..i) end
				return redis.call('SCARD',KEYS[1])`,
				'1', `${isolatedPrefix}:queues`
			)).toBe(999)
			for (const [id, queue] of [['queue-capacity-a', 'new-a'], ['queue-capacity-b', 'new-b']]) {
				await isolated.schedules.saveSchedule({
					id: id!, task: 'task', queue: queue!, kind: 'interval', intervalMs: 1_000,
					nextRunAt: 1, policy: {misfire: 'fire-once', overlap: 'allow'}
				})
			}
			let sequence = 0
			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 10,
				createRun: (schedule, runAt) => ({
					...queuedRun(`queue-capacity-generated-${sequence++}`),
					queue: schedule.queue!, scheduleId: schedule.id, runAt, createdAt: 2, updatedAt: 2
				})
			})

			expect(triggered.flatMap((result) => result.runs)).toHaveLength(1)
			expect(await redisCli('SCARD', `${isolatedPrefix}:queues`)).toBe(1_000)
			await isolated.schedules.saveSchedule({
				id: 'queue-capacity-c-existing', task: 'task', queue: 'existing-1', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1,
				policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			await redisCli('EVAL', `local p=KEYS[1];for i=1,100 do
				local id='queue-capacity-b-blocked-'..string.format('%03d',i)
				local schedule={id=id,task='task',queue='blocked-'..i,kind='interval',
				intervalMs=1000,nextRunAt=1,policy={misfire='fire-once',overlap='allow'}}
				redis.call('HSET',p..':schedules',id,cjson.encode(schedule))
				redis.call('ZADD',p..':schedule-due',1,id) end;return 1`, '1', isolatedPrefix)
			await expect(isolated.schedules.triggerDueSchedules({
				now: 3, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`queue-capacity-blocked-${schedule.id}`), queue: schedule.queue!,
					scheduleId: schedule.id, runAt, createdAt: 3, updatedAt: 3
				})
			})).resolves.toEqual([])
			expect(await redisCli('ZRANGE', `${isolatedPrefix}:schedule-due`, '0', '0'))
				.toEqual(['queue-capacity-c-existing'])
			const afterSaturation = await isolated.schedules.triggerDueSchedules({
				now: 4, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`queue-capacity-generated-${sequence++}`),
					queue: schedule.queue!, scheduleId: schedule.id, runAt, createdAt: 4, updatedAt: 4
				})
			})
			expect(afterSaturation.map((result) => result.schedule.id))
				.toEqual(['queue-capacity-c-existing'])
		} finally { await clearPrefix(isolatedPrefix) }
	}, 15_000)

	it('preflights every claimed schedule before a Redis batch writes', async() => {
		const isolatedNamespace = `${namespace}-schedule-preflight`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		let corrupted = false
		const corruptingRedis = {
			async ping() { return redis.ping() },
			async eval<T>(script: string, keys: readonly string[], args: readonly (string | number)[] = []) {
				if (!corrupted && args[0] === 'commitSchedules') {
					corrupted = true
					await redisCli('HSET', `${isolatedPrefix}:schedules`, 'atomic-b', '{')
				}
				return redis.eval!(script, keys, args) as Promise<T>
			}
		} as unknown as RedisPort
		const isolated = createRedisJobsBackend({redis: corruptingRedis, namespace: isolatedNamespace})
		try {
			for (const id of ['atomic-a', 'atomic-b']) {
				await isolated.schedules.saveSchedule({
					id, task: 'task', kind: 'interval', intervalMs: 1_000, nextRunAt: 1,
					policy: {misfire: 'fire-once', overlap: 'allow'}
				})
			}
			let sequence = 0
			await expect(isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`atomic-generated-${sequence++}`), scheduleId: schedule.id,
					runAt, createdAt: 2, updatedAt: 2
				})
			})).rejects.toThrow()

			expect(corrupted).toBe(true)
			expect(await redisCli('HLEN', `${isolatedPrefix}:runs`)).toBe(0)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('isolates malformed and invalid due schedules from healthy schedules', async() => {
		const isolatedNamespace = `${namespace}-malformed-schedule-claim`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.getRun('compatibility-probe')
			await isolated.schedules.saveSchedule({
				id: 'healthy', task: 'task', kind: 'interval', intervalMs: 1_000, nextRunAt: 1,
				policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			await isolated.schedules.saveSchedule({
				id: 'disabled-stale-index', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, enabled: false, policy: {misfire: 'fire-once', overlap: 'allow'}
			})
			await redisCli('ZADD', `${isolatedPrefix}:schedule-due`, '1', 'disabled-stale-index')
			await redisCli('HSET', `${isolatedPrefix}:schedules`, 'corrupt', '{')
			await redisCli('ZADD', `${isolatedPrefix}:schedule-due`, '1', 'corrupt')
			await redisCli('HSET', `${isolatedPrefix}:schedules`, 'invalid', JSON.stringify({
				id: 'invalid', task: '', kind: 'interval', intervalMs: 1_000, nextRunAt: 1,
				policy: {misfire: 'fire-once', overlap: 'allow'}
			}))
			await redisCli('ZADD', `${isolatedPrefix}:schedule-due`, '1', 'invalid')
			await redisCli('HSET', `${isolatedPrefix}:schedules`, 'invalid-policy', JSON.stringify({
				id: 'invalid-policy', task: 'task', kind: 'interval', intervalMs: 1_000,
				nextRunAt: 1, policy: 1
			}))
			await redisCli('ZADD', `${isolatedPrefix}:schedule-due`, '1', 'invalid-policy')
			let sequence = 0
			const trigger = (now: number) => isolated.schedules.triggerDueSchedules({
				now, maxCatchUp: 1, allowedMisfire: ['fire-once'], allowedOverlap: ['allow'],
				createRun: (schedule, runAt) => ({
					...queuedRun(`healthy-generated-${sequence++}`), scheduleId: schedule.id,
					runAt, createdAt: now, updatedAt: now
				})
			})

			expect((await trigger(2)).flatMap((result) => result.runs).map((run) => run.id))
				.toEqual(['healthy-generated-0'])
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:schedule-due`, 'corrupt')).toBeNull()
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:schedule-due`, 'invalid')).toBeNull()
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:schedule-due`, 'invalid-policy'
			)).toBeNull()
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:schedule-due`, 'disabled-stale-index'
			)).toBeNull()
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('quarantines oversized due and expired schedule claims without starving healthy work', async() => {
		const isolatedNamespace = `${namespace}-oversized-expired-schedule`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.schedules.saveSchedule({
				id: 'healthy-after-oversized', task: 'task', kind: 'interval',
				intervalMs: 1_000, nextRunAt: 1
			})
			await redisCli('EVAL', `local p=KEYS[1];local id='oversized-expired';local schedule={
				id=id,task='task',kind='interval',intervalMs=1000,nextRunAt=1,
				payload={blob=string.rep('x',4*1024*1024)}}
				redis.call('HSET',p..':schedules',id,cjson.encode(schedule))
				redis.call('ZADD',p..':schedule-processing',1,id)
				redis.call('HSET',p..':schedule-tokens',id,'token')
				redis.call('HSET',p..':schedule-hashes',id,'hash')
				id='oversized-due';schedule.id=id
				redis.call('HSET',p..':schedules',id,cjson.encode(schedule))
				redis.call('ZADD',p..':schedule-due',0,id);return 1`, '1', isolatedPrefix)

			const triggered = await isolated.schedules.triggerDueSchedules({
				now: 2, maxCatchUp: 1,
				createRun: (schedule, runAt) => ({
					...queuedRun(`generated-${schedule.id}`), scheduleId: schedule.id, runAt
				})
			})

			expect(triggered.map((result) => result.schedule.id)).toEqual(['healthy-after-oversized'])
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:schedule-processing`, 'oversized-expired'
			)).toBeNull()
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:schedule-due`, 'oversized-expired'
			)).toBeNull()
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:schedule-due`, 'oversized-due'
			)).toBeNull()
		} finally { await clearPrefix(isolatedPrefix) }
	}, 15_000)

	it('expires a dead-letter run and its sidecar atomically', async() => {
		await backend.runs.appendRun(queuedRun('expired-dead'))
		const [claimed] = await backend.runs.claimDueRuns({
			now: 2, workerId: 'retention-worker', limit: 1, maxConcurrentRuns: 2, leaseMs: 100
		})
		expect(claimed?.id).toBe('expired-dead')
		const {
			leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt,
			lastHeartbeatAt: _lastHeartbeatAt, ...claimData
		} = claimed!
		const terminal: StoredJobRun = {
			...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
			terminalExpiresAt: 4, failureCode: 'failed'
		}
		const dead: StoredDeadLetter = {
			id: 'dead-expired', runId: terminal.id, queue: terminal.queue, task: terminal.task,
			failureCode: 'failed', attempts: terminal.attempt, failedAt: 3
		}
		expect(await backend.runs.deadLetterRun(terminal, claimed!.leaseToken!, dead)).toBe(true)
		expect(await backend.maintenance.cleanupTerminalRuns(4, 10)).toBe(1)
		await expect(backend.runs.getRun(terminal.id)).resolves.toBeUndefined()
		await expect(backend.admin.listDeadLetters()).resolves.toEqual([])
	})

	it('quarantines a corrupt dead-letter relationship without blocking healthy retention', async() => {
		const isolatedNamespace = `${namespace}-retention-relationship-corruption`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			for (const id of ['a-corrupt-terminal', 'z-healthy-terminal']) {
				await isolated.runs.appendRun(queuedRun(id))
			}
			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'retention-corruption-worker', limit: 2,
				maxConcurrentRuns: 2, leaseMs: 100
			})
			for (const run of claimed) {
				const {
					leaseOwner: _leaseOwner, leaseToken: _leaseToken,
					leaseExpiresAt: _leaseExpiresAt, lastHeartbeatAt: _lastHeartbeatAt,
					...claimData
				} = run
				const terminal: StoredJobRun = {
					...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
					terminalExpiresAt: 4, failureCode: 'failed'
				}
				const dead: StoredDeadLetter = {
					id: `dead-${run.id}`, runId: run.id, queue: run.queue, task: run.task,
					failureCode: 'failed', attempts: run.attempt, failedAt: 3
				}
				expect(await isolated.runs.deadLetterRun(terminal, run.leaseToken!, dead)).toBe(true)
			}
			await redisCli(
				'HSET', `${isolatedPrefix}:dead-by-run`, 'a-corrupt-terminal', 'missing-dead-letter'
			)

			expect(await isolated.maintenance.cleanupTerminalRuns(4, 10)).toBe(1)
			await expect(isolated.runs.getRun('z-healthy-terminal')).resolves.toBeUndefined()
			await expect(isolated.runs.getRun('a-corrupt-terminal'))
				.resolves.toMatchObject({status: 'dead-lettered'})
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:terminal`, 'a-corrupt-terminal')).toBeNull()
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('does not expire an active idempotency claim from a stale expiry score', async() => {
		const isolatedNamespace = `${namespace}-idempotency-expiry-repair`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		const idempotency = {key: 'active-claim', checksum: 'a'.repeat(64), expiresAt: 1_000}
		try {
			await isolated.runs.appendRun(queuedRun('protected-run'), idempotency)
			await redisCli('ZADD', `${isolatedPrefix}:idempotency-expiry`, '1', idempotency.key)

			expect(await isolated.maintenance.cleanupTerminalRuns(2, 10)).toBe(0)
			const duplicate = await isolated.runs.appendRun(queuedRun('duplicate-run'), idempotency)

			expect(duplicate).toMatchObject({existing: true, run: {id: 'protected-run'}})
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:idempotency-expiry`, idempotency.key
			)).toBe(1_000)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('rebuilds a lost idempotency-expiry index before retention', async() => {
		const isolatedNamespace = `${namespace}-idempotency-expiry-drift`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('expired-idempotency-owner'), {
				key: 'expired-claim', checksum: 'e'.repeat(64), expiresAt: 2
			})
			await redisCli('DEL', `${isolatedPrefix}:idempotency-expiry`)

			await expect(isolated.maintenance.cleanupTerminalRuns(2, 1)).resolves.toBe(1)
			expect(await redisCli(
				'HEXISTS', `${isolatedPrefix}:idempotency`, 'expired-claim'
			)).toBe(0)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('fails closed before deleting a terminal run protected by corrupt idempotency metadata', async() => {
		const isolatedNamespace = `${namespace}-retention-idempotency-corruption`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		const idempotency = {key: 'corrupt-active-claim', checksum: 'a'.repeat(64), expiresAt: 1_000}
		try {
			await isolated.runs.appendRun(queuedRun('corrupt-claim-terminal'), idempotency)
			const [claimed] = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'corrupt-claim-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 100
			})
			const {
				leaseOwner: _leaseOwner, leaseToken: _leaseToken,
				leaseExpiresAt: _leaseExpiresAt, lastHeartbeatAt: _lastHeartbeatAt,
				...claimData
			} = claimed!
			const terminal: StoredJobRun = {
				...claimData, status: 'completed', updatedAt: 3, completedAt: 3,
				terminalAt: 3, terminalExpiresAt: 4
			}
			expect(await isolated.runs.completeRun(terminal, claimed!.leaseToken!)).toBe(true)
			await redisCli('HSET', `${isolatedPrefix}:idempotency`, idempotency.key, JSON.stringify({
				checksum: idempotency.checksum, expiresAt: idempotency.expiresAt
			}))

			await expect(isolated.maintenance.cleanupTerminalRuns(4, 10)).rejects.toThrow()
			await expect(isolated.runs.getRun(terminal.id))
				.resolves.toMatchObject({status: 'completed', terminalExpiresAt: 4})
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:terminal`, terminal.id)).toBe(4)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('replaces a source idempotency claim at full Redis capacity', async() => {
		const isolatedNamespace = `${namespace}-dead-requeue-idempotency-capacity`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		const sourceChecksum = 'a'.repeat(64)
		const replacementChecksum = 'b'.repeat(64)
		try {
			const source: StoredJobRun = {
				...queuedRun('idempotency-source'), idempotencyKey: 'source-idempotency',
				idempotencyChecksum: sourceChecksum, idempotencyExpiresAt: 1_000
			}
			await isolated.runs.appendRun(source, {
				key: 'source-idempotency', checksum: sourceChecksum, expiresAt: 1_000
			})
			const [claimed] = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'idempotency-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 100
			})
			const {
				leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt,
				lastHeartbeatAt: _lastHeartbeatAt, ...claimData
			} = claimed!
			const terminal: StoredJobRun = {
				...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
				failureCode: 'failed'
			}
			const dead: StoredDeadLetter = {
				id: 'idempotency-dead', runId: terminal.id, queue: terminal.queue, task: terminal.task,
				failureCode: 'failed', attempts: terminal.attempt, failedAt: 3, payload: terminal.payload
			}
			expect(await isolated.runs.deadLetterRun(terminal, claimed!.leaseToken!, dead)).toBe(true)
			expect(await redisCli('EVAL', `for i=1,9999 do local key='capacity-'..i
				redis.call('HSET',KEYS[1],key,cjson.encode({runId='other-'..i,checksum=string.rep('c',64),expiresAt=1000}))
				end return redis.call('HLEN',KEYS[1])`, '1', `${isolatedPrefix}:idempotency`)).toBe(10_000)
			const replacement: StoredJobRun = {
				...queuedRun('idempotency-replacement'), payload: source.payload,
				createdAt: 4, updatedAt: 4, runAt: 4,
				idempotencyKey: 'replacement-idempotency',
				idempotencyChecksum: replacementChecksum, idempotencyExpiresAt: 1_000
			}

			await expect(isolated.admin!.requeueDeadLetter(dead.id, replacement, {
				key: 'replacement-idempotency', checksum: replacementChecksum, expiresAt: 1_000
			})).resolves.toMatchObject({id: replacement.id})
			expect(await redisCli('HLEN', `${isolatedPrefix}:idempotency`)).toBe(10_000)
			expect(await redisCli('HEXISTS', `${isolatedPrefix}:idempotency`, 'source-idempotency')).toBe(0)
			expect(await redisCli('HEXISTS', `${isolatedPrefix}:idempotency`, 'replacement-idempotency')).toBe(1)
		} finally { await clearPrefix(isolatedPrefix) }
	}, 15_000)

	it('backfills dead-letter and terminal indexes before retention cleanup', async() => {
		const upgradeNamespace = `${namespace}-retention-upgrade`
		const upgradePrefix = `jobs:{${createHash('sha256').update(upgradeNamespace).digest('hex').slice(0, 32)}}`
		const upgradeBackend = createRedisJobsBackend({redis, namespace: upgradeNamespace})
		try {
			await upgradeBackend.runs.appendRun(queuedRun('expired-after-upgrade'))
			const [claimed] = await upgradeBackend.runs.claimDueRuns({
				now: 2, workerId: 'upgrade-retention-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 100
			})
			const {
				leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt,
				lastHeartbeatAt: _lastHeartbeatAt, ...claimData
			} = claimed!
			const terminal: StoredJobRun = {
				...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
				terminalExpiresAt: 4, failureCode: 'failed'
			}
			const dead: StoredDeadLetter = {
				id: 'dead-after-upgrade', runId: terminal.id, queue: terminal.queue,
				task: terminal.task, failureCode: 'failed', attempts: terminal.attempt, failedAt: 3
			}
			expect(await upgradeBackend.runs.deadLetterRun(terminal, claimed!.leaseToken!, dead)).toBe(true)
			await redisCli(
				'DEL', `${upgradePrefix}:dead-by-run`, `${upgradePrefix}:dead-meta-v3`,
				`${upgradePrefix}:dead-order`, `${upgradePrefix}:terminal`
			)
			await expect(upgradeBackend.maintenance.cleanupTerminalRuns(4, 1)).resolves.toBe(1)
			await expect(upgradeBackend.runs.getRun(terminal.id)).resolves.toBeUndefined()
			await expect(upgradeBackend.admin.listDeadLetters()).resolves.toEqual([])
		} finally { await clearPrefix(upgradePrefix) }
	})

	it('preflights idempotency records before mutating a dead-letter requeue', async() => {
		const isolatedNamespace = `${namespace}-dead-requeue-idempotency-corruption`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		const sourceChecksum = 'c'.repeat(64)
		try {
			const source: StoredJobRun = {
				...queuedRun('atomic-idempotency-source'), idempotencyKey: 'source-claim',
				idempotencyChecksum: sourceChecksum, idempotencyExpiresAt: 1_000
			}
			await isolated.runs.appendRun(source, {
				key: 'source-claim', checksum: sourceChecksum, expiresAt: 1_000
			})
			const [claimed] = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'atomic-idempotency-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 100
			})
			const {
				leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt,
				lastHeartbeatAt: _lastHeartbeatAt, ...claimData
			} = claimed!
			const terminal: StoredJobRun = {
				...claimData, status: 'dead-lettered', updatedAt: 3, terminalAt: 3,
				failureCode: 'failed'
			}
			const dead: StoredDeadLetter = {
				id: 'atomic-idempotency-dead', runId: terminal.id, queue: terminal.queue,
				task: terminal.task, failureCode: 'failed', attempts: terminal.attempt, failedAt: 3
			}
			expect(await isolated.runs.deadLetterRun(terminal, claimed!.leaseToken!, dead)).toBe(true)
			await redisCli('HSET', `${isolatedPrefix}:idempotency`, 'zz-corrupt', '{')

			const replacement = queuedRun('atomic-idempotency-replacement')
			await expect(isolated.admin!.requeueDeadLetter(dead.id, replacement))
				.rejects.toThrow()

			expect(await redisCli('HEXISTS', `${isolatedPrefix}:runs`, replacement.id)).toBe(0)
			expect(await redisCli('HEXISTS', `${isolatedPrefix}:runs`, source.id)).toBe(1)
			expect(await redisCli('HEXISTS', `${isolatedPrefix}:idempotency`, 'source-claim')).toBe(1)
			expect(await redisCli('HEXISTS', `${isolatedPrefix}:dead`, dead.id)).toBe(1)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('does not let saturated dead-letter capacity block stale recovery', async() => {
		await backend.runs.appendRun({
			...queuedRun('stale-at-capacity', 100), maxAttempts: 1,
			retryPolicy: {attempts: 1, baseDelayMs: 10}
		})
		const [claimed] = await backend.runs.claimDueRuns({
			now: 10, workerId: 'capacity-worker', limit: 1, maxConcurrentRuns: 4, leaseMs: 100
		})
		expect(claimed?.id).toBe('stale-at-capacity')
		expect(await redisCli(
			'EVAL', "for i=1,10000 do redis.call('HSET',KEYS[1],'capacity-'..i,'{}') end return redis.call('HLEN',KEYS[1])",
			'1', `${keyPrefix}:dead`
		)).toBe(10_000)

		await expect(backend.runs.recoverStaleLeases(110, 0, 200)).resolves.toBe(0)
		await expect(backend.runs.getRun(claimed!.id)).resolves.toMatchObject({status: 'running'})
	})

	it('isolates malformed and oversized running records from healthy stale recovery', async() => {
		const isolatedNamespace = `${namespace}-stale-recovery-metadata-corruption`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('stale-record-oversized', 120))
			await isolated.runs.appendRun(queuedRun('stale-record-corrupt', 110))
			await isolated.runs.appendRun(queuedRun('stale-metadata-corrupt', 100))
			await isolated.runs.appendRun(queuedRun('stale-metadata-healthy', 90))
			const claimed = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'stale-metadata-worker', limit: 4,
				maxConcurrentRuns: 4, leaseMs: 100
			})
			expect(claimed.map((run) => run.id)).toEqual([
				'stale-record-oversized', 'stale-record-corrupt',
				'stale-metadata-corrupt', 'stale-metadata-healthy'
			])
			await redisCli('HSET', `${isolatedPrefix}:running-meta-v2`, 'stale-metadata-corrupt', '{')
			await redisCli('HSET', `${isolatedPrefix}:runs`, 'stale-record-corrupt', JSON.stringify({
				id: 'stale-record-corrupt', status: 'running', attempt: 1, maxAttempts: 2,
				leaseExpiresAt: 102
			}))
			await redisCli('EVAL', `local p=KEYS[1];local id='stale-record-oversized';local run={
				id=id,task='task',queue='default',payload={blob=string.rep('x',4*1024*1024)},
				status='running',createdAt=1,updatedAt=2,runAt=1,priority=120,attempt=1,
				maxAttempts=2,retryPolicy={attempts=2,baseDelayMs=10},
				leaseOwner='stale-metadata-worker',leaseToken='token',leaseExpiresAt=102,
				lastHeartbeatAt=2};redis.call('HSET',p..':runs',id,cjson.encode(run));return 1`,
			'1', isolatedPrefix)

			expect(await isolated.runs.recoverStaleLeases(102, 0)).toBe(2)
			await expect(isolated.runs.getRun('stale-metadata-healthy'))
				.resolves.toMatchObject({status: 'retryable'})
			await expect(isolated.runs.getRun('stale-metadata-corrupt'))
				.resolves.toMatchObject({status: 'retryable'})
			expect(await redisCli('ZSCORE', `${isolatedPrefix}:leases`, 'stale-record-corrupt')).toBeNull()
			expect(await redisCli(
				'ZSCORE', `${isolatedPrefix}:leases`, 'stale-record-oversized'
			)).toBeNull()
			expect(await redisCli(
				'HEXISTS', `${isolatedPrefix}:running-meta-v2`, 'stale-record-corrupt'
			)).toBe(0)
			expect(await redisCli('GET', `${isolatedPrefix}:running-count`)).toBe('0')
		} finally { await clearPrefix(isolatedPrefix) }
	}, 15_000)

	it('backfills the global ready index for an existing native namespace', async() => {
		const upgradeNamespace = `${namespace}-ready-upgrade`
		const upgradePrefix = `jobs:{${createHash('sha256').update(upgradeNamespace).digest('hex').slice(0, 32)}}`
		const upgradeBackend = createRedisJobsBackend({redis, namespace: upgradeNamespace})
		await upgradeBackend.runs.appendRun(queuedRun('ready-after-upgrade'))
		try {
			await redisCli(
				'DEL', `${upgradePrefix}:ready-v3`, `${upgradePrefix}:ready-v3-c`,
				`${upgradePrefix}:runnable-meta-v2`, `${upgradePrefix}:ready`, `${upgradePrefix}:delayed`
			)
			await expect(upgradeBackend.runs.claimDueRuns({
				now: 2, workerId: 'upgrade-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})).resolves.toEqual([expect.objectContaining({id: 'ready-after-upgrade'})])
			await upgradeBackend.runs.appendRun(queuedRun('ready-after-mirror-loss'))
			await redisCli(
				'DEL', `${upgradePrefix}:runnable-meta-v2`, `${upgradePrefix}:ready`,
				`${upgradePrefix}:delayed`
			)
			await expect(upgradeBackend.runs.claimDueRuns({
				now: 3, workerId: 'repair-worker', limit: 1,
				maxConcurrentRuns: 2, leaseMs: 1_000
			})).resolves.toEqual([expect.objectContaining({id: 'ready-after-mirror-loss'})])
		} finally { await clearPrefix(upgradePrefix) }
	})

	it('isolates malformed runs while rebuilding the global ready index', async() => {
		const isolatedNamespace = `${namespace}-ready-rebuild-corruption`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const initial = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await initial.runs.appendRun(queuedRun('ready-rebuild-healthy'))
			await initial.runs.appendRun(queuedRun('ready-rebuild-corrupt'))
			await redisCli('HSET', `${isolatedPrefix}:runs`, 'ready-rebuild-corrupt', '{')
			await redisCli(
				'DEL', `${isolatedPrefix}:ready-v3`, `${isolatedPrefix}:ready-v3-c`,
				`${isolatedPrefix}:ready`, `${isolatedPrefix}:delayed`, `${isolatedPrefix}:runnable-meta-v2`
			)

			const upgraded = createRedisJobsBackend({redis, namespace: isolatedNamespace})
			const claimed = await upgraded.runs.claimDueRuns({
				now: 2, workerId: 'ready-rebuild-worker', limit: 2,
				maxConcurrentRuns: 2, leaseMs: 100
			})

			expect(claimed.map((run) => run.id)).toEqual(['ready-rebuild-healthy'])
			expect(await redisCli('EXISTS', `${isolatedPrefix}:ready-v3`)).toBe(1)
		} finally { await clearPrefix(isolatedPrefix) }
	})

	it('incrementally backfills run order, running counts and queue stats', async() => {
		const upgradeNamespace = `${namespace}-run-index-upgrade`
		const upgradePrefix = `jobs:{${createHash('sha256').update(upgradeNamespace).digest('hex').slice(0, 32)}}`
		const originalBackend = createRedisJobsBackend({redis, namespace: upgradeNamespace})
		try {
			for (let index = 1; index <= 33; index += 1) {
				await originalBackend.runs.appendRun(queuedRun(`upgrade-${String(index).padStart(2, '0')}`))
			}
			await expect(originalBackend.runs.claimDueRuns({
				now: 2, workerId: 'existing-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})).resolves.toHaveLength(1)
			await redisCli(
				'DEL', `${upgradePrefix}:run-order-v1`, `${upgradePrefix}:run-order-v1-cursor`,
				`${upgradePrefix}:idx:runs-order`, `${upgradePrefix}:running-counts-v2`,
				`${upgradePrefix}:running-counts-v2-cursor`, `${upgradePrefix}:running-meta-v2`, `${upgradePrefix}:running-count`,
				`${upgradePrefix}:running-tasks`, `${upgradePrefix}:queue-stats-v1`,
				`${upgradePrefix}:queue-stats-v1-cursor`, `${upgradePrefix}:queue-status-counts`,
				`${upgradePrefix}:idx:queue-due:default`
			)
			const upgradedBackend = createRedisJobsBackend({redis, namespace: upgradeNamespace})
			await expect(upgradedBackend.admin.listRuns({limit: 100})).resolves.toHaveLength(33)
			await expect(upgradedBackend.admin.getQueueStats('default', 2)).resolves.toEqual([
				expect.objectContaining({queue: 'default', queued: 32, running: 1})
			])
			await expect(upgradedBackend.runs.claimDueRuns({
				now: 2, workerId: 'blocked-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})).resolves.toEqual([])
		} finally { await clearPrefix(upgradePrefix) }
	}, 30_000)

	it('isolates queue-stat corruption while keeping running-count rebuilds fail-closed', async() => {
		const upgradeNamespace = `${namespace}-counter-rebuild-preflight`
		const upgradePrefix = `jobs:{${createHash('sha256').update(upgradeNamespace).digest('hex').slice(0, 32)}}`
		const upgradeBackend = createRedisJobsBackend({redis, namespace: upgradeNamespace})
		try {
			await upgradeBackend.runs.appendRun(queuedRun('rebuild-running'))
			await upgradeBackend.runs.appendRun(queuedRun('rebuild-queued'))
			await upgradeBackend.runs.claimDueRuns({
				now: 2, workerId: 'rebuild-worker', limit: 1, maxConcurrentRuns: 1, leaseMs: 1_000
			})
			await redisCli('HSET', `${upgradePrefix}:runs`, 'zz-corrupt', '{')
			await redisCli(
				'DEL', `${upgradePrefix}:running-counts-v2`, `${upgradePrefix}:running-counts-v2-cursor`,
				`${upgradePrefix}:running-counts-v2-rebuild-count`, `${upgradePrefix}:running-counts-v2-rebuild-tasks`,
				`${upgradePrefix}:running-count`, `${upgradePrefix}:running-tasks`, `${upgradePrefix}:running-meta-v2`,
				`${upgradePrefix}:queue-stats-v1`, `${upgradePrefix}:queue-stats-v1-cursor`,
				`${upgradePrefix}:queue-stats-v1-rebuild-counts`, `${upgradePrefix}:queue-status-counts`
			)
			const rebuildingBackend = createRedisJobsBackend({redis, namespace: upgradeNamespace})

			await expect(rebuildingBackend.admin.getQueueStats('default', 2)).resolves.toEqual([
				expect.objectContaining({queued: 1, running: 1})
			])
			expect(await redisCli('HLEN', `${upgradePrefix}:queue-stats-v1-rebuild-counts`)).toBe(0)
			expect(await redisCli('EXISTS', `${upgradePrefix}:queue-stats-v1`)).toBe(1)
			await expect(rebuildingBackend.runs.claimDueRuns({
				now: 2, workerId: 'blocked-rebuild-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})).rejects.toThrow()
			expect(await redisCli('GET', `${upgradePrefix}:running-counts-v2-rebuild-count`)).toBe('0')

			await redisCli('HDEL', `${upgradePrefix}:runs`, 'zz-corrupt')
			await redisCli(
				'DEL', `${upgradePrefix}:running-counts-v2`, `${upgradePrefix}:running-counts-v2-cursor`,
				`${upgradePrefix}:running-counts-v2-rebuild-count`, `${upgradePrefix}:running-counts-v2-rebuild-tasks`,
				`${upgradePrefix}:queue-stats-v1`, `${upgradePrefix}:queue-stats-v1-cursor`,
				`${upgradePrefix}:queue-stats-v1-rebuild-counts`
			)
			const repairedBackend = createRedisJobsBackend({redis, namespace: upgradeNamespace})
			await expect(repairedBackend.runs.claimDueRuns({
				now: 2, workerId: 'blocked-rebuild-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})).resolves.toEqual([])
			await expect(repairedBackend.admin.getQueueStats('default', 2)).resolves.toEqual([
				expect.objectContaining({queued: 1, running: 1})
			])
		} finally { await clearPrefix(upgradePrefix) }
	}, 15_000)

	it('rebuilds drifted running mirrors before enforcing concurrency', async() => {
		const isolatedNamespace = `${namespace}-running-mirror-drift`
		const isolatedPrefix = `jobs:{${createHash('sha256').update(isolatedNamespace).digest('hex').slice(0, 32)}}`
		const isolated = createRedisJobsBackend({redis, namespace: isolatedNamespace})
		try {
			await isolated.runs.appendRun(queuedRun('already-running', 10))
			await isolated.runs.appendRun(queuedRun('must-wait', 5))
			const [running] = await isolated.runs.claimDueRuns({
				now: 2, workerId: 'first-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})
			expect(running?.id).toBe('already-running')
			expect(await redisCli('EXISTS', `${isolatedPrefix}:running-counts-v2`)).toBe(1)
			await redisCli(
				'DEL', `${isolatedPrefix}:running-count`, `${isolatedPrefix}:running-tasks`,
				`${isolatedPrefix}:running-meta-v2`, `${isolatedPrefix}:leases`,
				`${isolatedPrefix}:idx:status:running`
			)

			await expect(isolated.runs.claimDueRuns({
				now: 3, workerId: 'blocked-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})).resolves.toEqual([])
			expect(await redisCli('GET', `${isolatedPrefix}:running-count`)).toBe('1')
			expect(await redisCli('HLEN', `${isolatedPrefix}:running-meta-v2`)).toBe(1)
			expect(await redisCli('ZCARD', `${isolatedPrefix}:leases`)).toBe(1)
			await redisCli('HSET', `${isolatedPrefix}:running-tasks`, 'task', 'not-a-count')
			await expect(isolated.runs.claimDueRuns({
				now: 3, workerId: 'still-blocked-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000, concurrencyByTask: {task: 1}
			})).resolves.toEqual([])
			expect(await redisCli('HGET', `${isolatedPrefix}:running-tasks`, 'task')).toBe('1')

			await expect(isolated.runs.releaseClaim(running!.id, running!.leaseToken!, 3))
				.resolves.toBe(true)
			await expect(isolated.runs.claimDueRuns({
				now: 4, workerId: 'next-worker', limit: 1,
				maxConcurrentRuns: 1, leaseMs: 1_000
			})).resolves.toEqual([expect.objectContaining({id: 'already-running'})])
		} finally { await clearPrefix(isolatedPrefix) }
	}, 15_000)

	it('preserves task concurrency while scanning the global ready index', async() => {
		const indexedNamespace = `${namespace}-ready-concurrency`
		const indexedPrefix = `jobs:{${createHash('sha256').update(indexedNamespace).digest('hex').slice(0, 32)}}`
		const indexedBackend = createRedisJobsBackend({redis, namespace: indexedNamespace})
		try {
			await indexedBackend.runs.appendRun({...queuedRun('limited-high', 100), task: 'limited'})
			await indexedBackend.runs.appendRun({...queuedRun('limited-next', 90), task: 'limited'})
			await indexedBackend.runs.appendRun({...queuedRun('open-one', 80), task: 'open'})
			await indexedBackend.runs.appendRun({...queuedRun('open-two', 70), task: 'open'})
			const claimed = await indexedBackend.runs.claimDueRuns({
				now: 2, workerId: 'indexed-worker', limit: 3, maxConcurrentRuns: 3,
				leaseMs: 1_000, concurrencyByTask: {limited: 1}
			})
			expect(claimed.map((run) => run.id)).toEqual(['limited-high', 'open-one', 'open-two'])
		} finally { await clearPrefix(indexedPrefix) }
	})

	it('backfills and maintains filtered schedule indexes', async() => {
		const indexedNamespace = `${namespace}-schedule-upgrade`
		const indexedPrefix = `jobs:{${createHash('sha256').update(indexedNamespace).digest('hex').slice(0, 32)}}`
		const indexedBackend = createRedisJobsBackend({redis, namespace: indexedNamespace})
		await indexedBackend.schedules.getSchedule('compatibility-probe')
		try {
			expect(await redisCli(
				'EVAL',
				`local p=KEYS[1]
				for i=1,33 do
					local id=string.format('legacy-%02d',i);local schedule={id=id,task=i%2==0 and 'even' or 'odd',queue='legacy',kind='interval',intervalMs=60000,enabled=i%3~=0,nextRunAt=60000,payload={}}
					redis.call('HSET',p..':schedules',id,cjson.encode(schedule))
				end
				redis.call('DEL',p..':schedule-order-v1',p..':schedule-order-v1-cursor',p..':schedule-order')
				return redis.call('HLEN',p..':schedules')`,
				'1', indexedPrefix
			)).toBe(33)
			await expect(indexedBackend.admin.listSchedules({
				queue: 'legacy', task: 'even', enabled: true, limit: 100
			})).resolves.toHaveLength(11)

			const replacement: StoredSchedule = {
				id: 'legacy-02', task: 'even', queue: 'replacement', kind: 'interval',
				intervalMs: 60_000, enabled: false, nextRunAt: 60_000, payload: {}
			}
			await indexedBackend.schedules.saveSchedule(replacement)
			await expect(indexedBackend.admin.listSchedules({
				queue: 'legacy', task: 'even', enabled: true, limit: 100
			})).resolves.toHaveLength(10)
			await expect(indexedBackend.admin.listSchedules({
				queue: 'replacement', task: 'even', enabled: false, limit: 100
			})).resolves.toEqual([replacement])
			await indexedBackend.schedules.deleteSchedule(replacement.id)
			await expect(indexedBackend.admin.listSchedules({queue: 'replacement'})).resolves.toEqual([])
		} finally { await clearPrefix(indexedPrefix) }
	})

	it('lists a filtered page without decoding the complete schedule population', async() => {
		const scaleNamespace = `${namespace}-schedule-scale`
		const scalePrefix = `jobs:{${createHash('sha256').update(scaleNamespace).digest('hex').slice(0, 32)}}`
		const scaleBackend = createRedisJobsBackend({redis, namespace: scaleNamespace})
		await scaleBackend.schedules.getSchedule('compatibility-probe')
		try {
			const populated = await redisCli(
				'EVAL',
				`local p=KEYS[1];local blob=string.rep('x',32768)
				for i=1,5000 do
					local id=string.format('schedule-%05d',i);local task=i%2==0 and 'task-a' or 'task-b';local queue=i%3==0 and 'queue-a' or 'queue-b';local enabled=i%5~=0
					local schedule={id=id,task=task,queue=queue,kind='interval',intervalMs=60000,enabled=enabled,nextRunAt=60000,payload={blob=blob}}
					redis.call('HSET',p..':schedules',id,cjson.encode(schedule));local e=enabled and '1' or '0'
					local keys={p..':schedule-order',p..':idx:schedule-queue-order:'..queue,p..':idx:schedule-task-order:'..task,p..':idx:schedule-enabled-order:'..e,p..':idx:schedule-queue-task-order:'..queue..':'..task,p..':idx:schedule-queue-enabled-order:'..queue..':'..e,p..':idx:schedule-task-enabled-order:'..task..':'..e,p..':idx:schedule-queue-task-enabled-order:'..queue..':'..task..':'..e}
					for _,key in ipairs(keys) do redis.call('ZADD',key,0,id) end
				end
				redis.call('SET',p..':schedule-order-v1','1');return redis.call('HLEN',p..':schedules')`,
				'1', scalePrefix
			)
			expect(populated).toBe(5_000)
			const startedAt = performance.now()
			const schedules = await scaleBackend.admin.listSchedules({
				queue: 'queue-a', task: 'task-a', enabled: true, limit: 100
			})
			const elapsedMs = performance.now() - startedAt
			expect(schedules).toHaveLength(100)
			expect(schedules[0]?.id).toBe('schedule-00006')
			expect(elapsedMs).toBeLessThan(5_000)
		} finally { await clearPrefix(scalePrefix) }
	}, 15_000)

	it('cleans one expired run without loading every dead-letter payload', async() => {
		const scaleNamespace = `${namespace}-dead-cleanup-scale`
		const scalePrefix = `jobs:{${createHash('sha256').update(scaleNamespace).digest('hex').slice(0, 32)}}`
		const scaleBackend = createRedisJobsBackend({redis, namespace: scaleNamespace})
		await scaleBackend.runs.getRun('compatibility-probe')
		try {
			const populated = await redisCli(
				'EVAL',
				`local p=KEYS[1];local blob=string.rep('x',32768)
				local run={id='expired-run',task='task',queue='queue',payload={},status='dead-lettered',createdAt=1,updatedAt=2,runAt=1,priority=0,attempt=1,maxAttempts=1,retryPolicy={attempts=1,baseDelayMs=0},terminalAt=2,terminalExpiresAt=3}
				redis.call('HSET',p..':runs',run.id,cjson.encode(run));redis.call('ZADD',p..':terminal',3,run.id)
				for i=1,5000 do
					local id=string.format('dead-%05d',i);local runId=i==1 and 'expired-run' or 'other-'..i
					local item={id=id,runId=runId,queue='queue',task='task',attempts=1,failedAt=2,payload={blob=blob}}
					redis.call('HSET',p..':dead',id,cjson.encode(item));redis.call('HSET',p..':dead-meta-v3',id,cjson.encode({id=id,runId=runId,queue='queue',task='task',reason='failed',attempts=1,failedAt=2}));redis.call('ZADD',p..':dead-order',2,id);redis.call('HSET',p..':dead-by-run',runId,id)
				end
				redis.call('SET',p..':dead-indexes-v3','1');return redis.call('HLEN',p..':dead')`,
				'1', scalePrefix
			)
			expect(populated).toBe(5_000)
			const startedAt = performance.now()
			await expect(scaleBackend.maintenance.cleanupTerminalRuns(3, 1)).resolves.toBe(1)
			const elapsedMs = performance.now() - startedAt
			expect(elapsedMs).toBeLessThan(5_000)
			await expect(scaleBackend.runs.getRun('expired-run')).resolves.toBeUndefined()
		} finally { await clearPrefix(scalePrefix) }
	}, 15_000)

	it('lists every dead-letter summary without materializing stored payloads', async() => {
		const scaleNamespace = `${namespace}-dead-list-scale`
		const scalePrefix = `jobs:{${createHash('sha256').update(scaleNamespace).digest('hex').slice(0, 32)}}`
		const scaleBackend = createRedisJobsBackend({redis, namespace: scaleNamespace})
		await scaleBackend.runs.getRun('compatibility-probe')
		try {
			const populated = await redisCli(
				'EVAL',
				`local p=KEYS[1];local blob=string.rep('x',32768)
				for i=1,1005 do local id=string.format('listed-%04d',i);local item={id=id,runId='run-'..i,queue='queue',task='task',reason='failed',attempts=1,failedAt=i,payload={blob=blob}};redis.call('HSET',p..':dead',id,cjson.encode(item));redis.call('ZADD',p..':dead-order',i,id) end
				redis.call('DEL',p..':dead-indexes-v3',p..':dead-indexes-v3-cursor',p..':dead-meta-v3');return redis.call('HLEN',p..':dead')`,
				'1', scalePrefix
			)
			expect(populated).toBe(1_005)
			const records = await scaleBackend.admin.listDeadLetters(10_000)
			expect(records).toHaveLength(1_005)
			expect(records[0]).toEqual(expect.objectContaining({id: 'listed-0001', runId: 'run-1'}))
			expect(records.at(-1)).toEqual(expect.objectContaining({id: 'listed-1005', runId: 'run-1005'}))
			expect(records.every((record) => record.payload === undefined)).toBe(true)
		} finally { await clearPrefix(scalePrefix) }
	}, 20_000)

	it('skips a paused ready population without decoding its payloads', async() => {
		const scaleNamespace = `${namespace}-paused-ready-scale`
		const scalePrefix = `jobs:{${createHash('sha256').update(scaleNamespace).digest('hex').slice(0, 32)}}`
		const scaleBackend = createRedisJobsBackend({redis, namespace: scaleNamespace})
		await scaleBackend.runs.getRun('compatibility-probe')
		try {
			const populated = await redisCli(
				'EVAL',
				`local p=KEYS[1];local blob=string.rep('x',32768)
				for i=1,5000 do
					local id=string.format('paused-%05d',i);local run={id=id,task='task',queue='paused',payload={blob=blob},status='queued',createdAt=1,updatedAt=1,runAt=1,priority=0,attempt=0,maxAttempts=1,retryPolicy={attempts=1,baseDelayMs=0}}
					redis.call('HSET',p..':runs',id,cjson.encode(run));redis.call('ZADD',p..':delayed',1,id);redis.call('HSET',p..':runnable-meta-v2',id,cjson.encode({id=id,queue='paused',task='task',runAt=1,priority=0}))
				end
				redis.call('SADD',p..':queues','paused');redis.call('SADD',p..':paused','paused');return redis.call('HLEN',p..':runs')`,
				'1', scalePrefix
			)
			expect(populated).toBe(5_000)
			const startedAt = performance.now()
			await expect(scaleBackend.runs.claimDueRuns({
				now: 2, workerId: 'paused-worker', limit: 1_024,
				maxConcurrentRuns: 1_024, leaseMs: 1_000
			})).resolves.toEqual([])
			const elapsedMs = performance.now() - startedAt
			expect(elapsedMs).toBeLessThan(5_000)
		} finally { await clearPrefix(scalePrefix) }
	}, 15_000)

	it('skips exhausted stale leases at dead-letter capacity without decoding payloads', async() => {
		const scaleNamespace = `${namespace}-stale-capacity-scale`
		const scalePrefix = `jobs:{${createHash('sha256').update(scaleNamespace).digest('hex').slice(0, 32)}}`
		const scaleBackend = createRedisJobsBackend({redis, namespace: scaleNamespace})
		await scaleBackend.runs.getRun('compatibility-probe')
		try {
			const populated = await redisCli(
				'EVAL',
				`local p=KEYS[1];local blob=string.rep('x',32768)
				for i=1,5000 do
					local id=string.format('stale-%05d',i);local run={id=id,task='task',queue='stale',payload={blob=blob},status='running',createdAt=1,updatedAt=1,runAt=1,priority=0,attempt=1,maxAttempts=1,retryPolicy={attempts=1,baseDelayMs=0},leaseOwner='worker',leaseToken='token-'..i,leaseExpiresAt=2,lastHeartbeatAt=1}
					redis.call('HSET',p..':runs',id,cjson.encode(run));redis.call('ZADD',p..':leases',2,id);redis.call('HSET',p..':running-meta-v2',id,cjson.encode({id=id,attempt=1,maxAttempts=1,leaseExpiresAt=2}))
				end
				for i=1,10000 do redis.call('HSET',p..':dead','capacity-'..i,'{}') end
				return redis.call('HLEN',p..':runs')`,
				'1', scalePrefix
			)
			expect(populated).toBe(5_000)
			const startedAt = performance.now()
			await expect(scaleBackend.runs.recoverStaleLeases(2, 0, 100)).resolves.toBe(0)
			const elapsedMs = performance.now() - startedAt
			expect(elapsedMs).toBeLessThan(5_000)
		} finally { await clearPrefix(scalePrefix) }
	}, 15_000)

	it('claims a maximum batch across thousands of ready groups without blocking Redis', async() => {
		const scaleNamespace = `${namespace}-scale`
		const scalePrefix = `jobs:{${createHash('sha256').update(scaleNamespace).digest('hex').slice(0, 32)}}`
		const scaleBackend = createRedisJobsBackend({redis, namespace: scaleNamespace})
		await scaleBackend.runs.getRun('compatibility-probe')
		try {
			const populated = await redisCli(
				'EVAL',
				`local p=KEYS[1]
				for i=1,2000 do
					local id='scale-'..i;local task='task-'..i
					local run={id=id,task=task,queue='scale',payload={},status='queued',createdAt=1,updatedAt=1,runAt=1,priority=0,attempt=0,maxAttempts=1,retryPolicy={attempts=1,baseDelayMs=0}}
					redis.call('HSET',p..':runs',id,cjson.encode(run));redis.call('ZADD',p..':delayed',1,id);redis.call('HSET',p..':runnable-meta-v2',id,cjson.encode({id=id,queue='scale',task=task,runAt=1,priority=0}));redis.call('SADD',p..':queues','scale')
					redis.call('SADD',p..':idx:status:queued',id);redis.call('SADD',p..':idx:queue:scale',id);redis.call('SADD',p..':idx:task:'..task,id)
					redis.call('HINCRBY',p..':queue-status-counts','scale:queued',1)
				end
				return redis.call('HLEN',p..':runs')`,
				'1', scalePrefix
			)
			expect(populated).toBe(2_000)
			const startedAt = performance.now()
			const claimed = await scaleBackend.runs.claimDueRuns({
				now: 2, workerId: 'scale-worker', limit: 1_024,
				maxConcurrentRuns: 1_024, leaseMs: 1_000
			})
			const elapsedMs = performance.now() - startedAt
			expect(claimed).toHaveLength(1_024)
			expect(elapsedMs).toBeLessThan(5_000)
		} finally { await clearPrefix(scalePrefix) }
	}, 10_000)
})
