import {readFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {describe, expect, it} from 'vitest'

import * as jobs from '../../src/jobs'
import * as redis from '../../src/jobs/backends-redis'
import * as sql from '../../src/jobs/backends-sql'
import * as redisMigration from '../../src/jobs/migrations-redis'
import * as sqlMigration from '../../src/jobs/migrations-sql'
import * as custom from '../../src/jobs/public/custom'
import * as development from '../../src/jobs/public/development'
import * as observability from '../../src/jobs/public/observability'
import * as production from '../../src/jobs/public/production'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('Jobs export contract', () => {
	it('exports only the new factories, registration, providers and migration paths', () => {
		expect(jobs.registerJobs).toBeTypeOf('function')
		expect(development.createDevelopmentJobs).toBeTypeOf('function')
		expect(production.createProductionJobs).toBeTypeOf('function')
		expect(custom.createCustomJobs).toBeTypeOf('function')
		expect(redis.createRedisJobsBackend).toBeTypeOf('function')
		expect(sql.createSqlJobsBackend).toBeTypeOf('function')
		expect(redisMigration.migrateRedisJobsSnapshot).toBeTypeOf('function')
		expect(sqlMigration.migrateSqlJobsSnapshot).toBeTypeOf('function')
		expect(observability.attachJobsObservability).toBeTypeOf('function')
		for (const removed of [
			'registerJobsScheduler', 'createDevelopmentJobsScheduler',
			'createProductionJobsScheduler', 'createCustomJobsScheduler'
		]) expect(jobs).not.toHaveProperty(removed)
		expect(redis).not.toHaveProperty('migrateRedisJobsSnapshot')
		expect(sql).not.toHaveProperty('migrateSqlJobsSnapshot')
	})

	it('publishes every documented Jobs subpath', async() => {
		const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
		for (const path of [
			'.', './development', './production', './custom',
			'./backends/redis', './backends/sql', './custom/backends/memory',
			'./admin', './observability', './migrations/sql', './migrations/redis'
		]) expect(manifest.exports).toHaveProperty(path)
		for (const removed of ['./public/types']) {
			expect(manifest.exports).not.toHaveProperty(removed)
		}
	})

	it('keeps the root registration path free of eager preset and backend imports', async() => {
		const source = await readFile(new URL('../../src/jobs/index.ts', import.meta.url), 'utf8')
		expect(source).not.toMatch(/^import (?!type\b).*\.\/public\/(?:development|production|custom)/mu)
		expect(source).not.toMatch(/^import .*\.\/features\/backends/mu)
		expect(source).toContain("await import('./public/development')")
		expect(source).toContain("await import('./public/production')")
		expect(source).toContain("await import('./public/custom')")
	})

	it('imports every built runtime, backend and migration subpath', async() => {
		const load = async(path: string) => await import(pathToFileURL(join(
			packageRoot, 'dist', path
		)).href)
		const [root, dev, prod, customPreset, redisBackend, sqlBackend, memoryBackend,
			admin, observabilityEntry, sqlMigrate, redisMigrate] = await Promise.all([
			load('index.js'), load('development.js'), load('production.js'), load('custom.js'),
			load('backends/redis.js'), load('backends/sql.js'), load('custom/backends/memory.js'),
			load('admin.js'), load('observability.js'), load('migrations/sql.js'), load('migrations/redis.js')
		])
		expect(Object.keys(root)).toEqual(['registerJobs'])
		expect(dev).toHaveProperty('createDevelopmentJobs')
		expect(prod).toHaveProperty('createProductionJobs')
		expect(customPreset).toHaveProperty('createCustomJobs')
		expect(redisBackend).toHaveProperty('createRedisJobsBackend')
		expect(sqlBackend).toHaveProperty('createSqlJobsBackend')
		expect(memoryBackend).toHaveProperty('createMemoryJobsBackend')
		expect(admin).toHaveProperty('JOBS_ADMIN_TOKEN')
		expect(observabilityEntry).toHaveProperty('attachJobsObservability')
		expect(sqlMigrate).toHaveProperty('migrateSqlJobsSnapshot')
		expect(redisMigrate).toHaveProperty('migrateRedisJobsSnapshot')
	})

	it('does not leak removed scheduler and backend-health contracts through declarations', async() => {
		const declarations = await Promise.all([
			'index.d.ts', 'development.d.ts', 'production.d.ts', 'custom.d.ts',
			'backends/redis.d.ts', 'backends/sql.d.ts', 'admin.d.ts'
		].map((name) => readFile(join(packageRoot, 'dist', name), 'utf8')))
		const text = declarations.join('\n')
		for (const removed of [
			'JobsSchedulerPort', 'JobsSchedulerHandler', 'BackendHealth', 'getBackendHealth',
			'registerJobsScheduler', 'createDevelopmentJobsScheduler', 'createProductionJobsScheduler',
			'createCustomJobsScheduler', 'RunStatus'
		]) expect(text).not.toContain(removed)
	})
})
