import {describe, expect, it} from 'vitest'

import {migrateRedisJobsSnapshot} from '../../src/jobs/features/backends/redis-migration'
import type {JobsRedisPort, StoredJobRun} from '../../src/jobs/types/backend'

const queuedRun = (id: string): StoredJobRun => ({
	id, task: 'task', queue: 'default', payload: {}, status: 'queued',
	createdAt: 1, updatedAt: 1, runAt: 1, priority: 0, attempt: 0, maxAttempts: 1,
	retryPolicy: {attempts: 1, baseDelayMs: 0}
})

describe('Redis jobs migration', () => {
	it('does not delete a legacy snapshot when a racing native marker lacks parity', async() => {
		const namespace = 'migration-race'
		const legacyKey = `${namespace}:snapshot`
		const snapshot = JSON.stringify({
			version: 1,
			data: JSON.stringify({
				runs: {run: queuedRun('run')}, schedules: {}, deadLetters: {},
				idempotency: {}, queuePaused: []
			})
		})
		let deleted = false
		const redis: JobsRedisPort = {
			async eval<T>(script, keys, arguments_ = []) {
				if (script.startsWith('return redis.call("GET"')) {
					return (keys[0] === legacyKey ? snapshot : null) as T
				}
				if (script.includes('redis.call("DEL"')) { deleted = true; return 1 as T }
				const operation = arguments_[0]
				if (operation === 'migrate') return JSON.stringify({migrated: false, already: true}) as T
				if (operation === 'verifyMigration') return 'false' as T
				throw new Error(`Unexpected Redis operation: ${String(operation)}`)
			}
		}

		await expect(migrateRedisJobsSnapshot({
			redis, namespace, deleteLegacySnapshot: true
		})).rejects.toThrow('JOBS_NATIVE_MIGRATION_INCOMPLETE')
		expect(deleted).toBe(false)
	})

	it('does not delete a newer legacy snapshot written while migration is running', async() => {
		const namespace = 'legacy-write-race'
		const legacyKey = `${namespace}:snapshot`
		const snapshot = JSON.stringify({
			version: 1,
			data: JSON.stringify({
				runs: {run: queuedRun('run')}, schedules: {}, deadLetters: {},
				idempotency: {}, queuePaused: []
			})
		})
		let deleted = false
		const redis: JobsRedisPort = {
			async eval<T>(script, keys, arguments_ = []) {
				if (script.startsWith('return redis.call("GET"')) {
					return (keys[0] === legacyKey ? snapshot : null) as T
				}
				if (script.includes('current~=ARGV[1]')) return 0 as T
				if (script.includes('redis.call("DEL"')) { deleted = true; return 1 as T }
				const operation = arguments_[0]
				if (operation === 'migrate') return JSON.stringify({migrated: true, already: false, runs: 1}) as T
				if (operation === 'verifyMigration') return 'true' as T
				throw new Error(`Unexpected Redis operation: ${String(operation)}`)
			}
		}

		await expect(migrateRedisJobsSnapshot({
			redis, namespace, deleteLegacySnapshot: true
		})).rejects.toThrow('JOBS_LEGACY_SNAPSHOT_CHANGED')
		expect(deleted).toBe(false)
	})
})
