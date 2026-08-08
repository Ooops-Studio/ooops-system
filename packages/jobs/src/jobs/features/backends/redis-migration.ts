import type {JobsRedisBackendOptions} from '../../types/backend'
import {getNextScheduleTime} from '../../utils/cron'

import {decodeProviderBoolean, parseProviderJson} from './backend-validation'
import {parseLegacyJobsState} from './legacy-migration'
import {redisJobsPrefix, validateRedisOptions} from './redis'
import {REDIS_NATIVE_SCRIPT} from './redis-native-script'

export interface RedisJobsMigrationResult {migrated: boolean; already: boolean; runs?: number}
export interface RedisJobsMigrationOptions extends JobsRedisBackendOptions {deleteLegacySnapshot?: boolean}

export async function migrateRedisJobsSnapshot(options: RedisJobsMigrationOptions): Promise<RedisJobsMigrationResult> {
	const configured = validateRedisOptions(options, false, new Set(['deleteLegacySnapshot']))
	const evalScript = configured.redis.eval?.bind(configured.redis)
	if (!evalScript) throw new Error('Redis jobs backend requires eval() support')
	const namespace = configured.namespace ?? 'jobs:scheduler'
	const nativePrefix = redisJobsPrefix(namespace)
	const legacyKey = `${namespace}:snapshot`
	const marker = await evalScript<string | null>('return redis.call("GET", KEYS[1])', [`${nativePrefix}:native-v2`])
	if (marker !== null && typeof marker !== 'string') throw new Error('Jobs Redis returned an invalid migration marker')
	const snapshot = await evalScript<string | null>('return redis.call("GET", KEYS[1])', [legacyKey])
	if (snapshot !== null && typeof snapshot !== 'string') throw new Error('Jobs Redis returned an invalid legacy snapshot')
	if (marker !== null && snapshot && marker !== 'migrated') {
		throw new Error('JOBS_NATIVE_INITIALIZATION_CONFLICT: legacy snapshot was not migrated')
	}
	let migrationSnapshot = snapshot
	let state: ReturnType<typeof parseLegacyJobsState> | undefined
	let wrapperUpdatedAt: number | undefined
	if (snapshot && (marker === null || configured.deleteLegacySnapshot)) {
		if (Buffer.byteLength(snapshot) > 70 * 1024 * 1024) throw new Error('Jobs Redis snapshot exceeds the migration size limit')
		const wrapper = JSON.parse(snapshot) as {version: number; data: string; updatedAt?: number}
		if (!wrapper || typeof wrapper !== 'object' || typeof wrapper.data !== 'string') throw new Error('Invalid Jobs Redis snapshot wrapper')
		state = parseLegacyJobsState(wrapper.version, wrapper.data)
		wrapperUpdatedAt = wrapper.updatedAt
		if (Object.keys(state.runs).length > 10_000
			|| Object.keys(state.deadLetters).length > 10_000
			|| Object.keys(state.idempotency).length > 10_000) {
			throw new Error('Jobs Redis snapshot exceeds native backend capacity')
		}
		migrationSnapshot = JSON.stringify({version: 1, data: JSON.stringify(state), updatedAt: wrapperUpdatedAt ?? Date.now()})
	}
	const verifyMigration = async(): Promise<void> => {
		const verified = await evalScript<string>(REDIS_NATIVE_SCRIPT, [nativePrefix], [
			'verifyMigration', JSON.stringify({snapshot: migrationSnapshot})
		])
		if (!decodeProviderBoolean(verified, 'migration verification result')) {
			throw new Error('JOBS_NATIVE_MIGRATION_INCOMPLETE')
		}
	}
	const deleteVerifiedLegacySnapshot = async(): Promise<void> => {
		if (!snapshot) return
		const deleted = await evalScript<number | string>(`local current=redis.call("GET",KEYS[1])
			if not current then return 2 end
			if current~=ARGV[1] then return 0 end
			redis.call("DEL",KEYS[1]);return 1`, [legacyKey], [snapshot])
		if (deleted !== 1 && deleted !== '1' && deleted !== 2 && deleted !== '2') {
			throw new Error('JOBS_LEGACY_SNAPSHOT_CHANGED')
		}
	}
	if (marker !== null) {
		if (configured.deleteLegacySnapshot && snapshot) {
			await verifyMigration()
			await deleteVerifiedLegacySnapshot()
		}
		return {migrated: false, already: true}
	}
	if (state) {
		const migrationNow = Date.now()
		for (const schedule of Object.values(state.schedules)) {
			if (schedule.enabled !== false && schedule.nextRunAt === undefined) {
				schedule.nextRunAt = getNextScheduleTime(schedule, migrationNow, true)
			}
		}
		migrationSnapshot = JSON.stringify({version: 1, data: JSON.stringify(state), updatedAt: wrapperUpdatedAt ?? Date.now()})
	}
	const raw = await evalScript<string>(REDIS_NATIVE_SCRIPT, [nativePrefix], [
		'migrate', JSON.stringify({snapshot: migrationSnapshot})
	])
	const result = parseProviderJson(raw, 'migration result') as Partial<RedisJobsMigrationResult>
	if (!result || typeof result !== 'object' || typeof result.migrated !== 'boolean'
		|| typeof result.already !== 'boolean'
		|| (result.runs !== undefined && (!Number.isSafeInteger(result.runs) || result.runs < 0 || result.runs > 10_000))) {
		throw new Error('Jobs Redis returned an invalid migration result')
	}
	if (configured.deleteLegacySnapshot && snapshot) {
		await verifyMigration()
		await deleteVerifiedLegacySnapshot()
	}
	return result as RedisJobsMigrationResult
}
