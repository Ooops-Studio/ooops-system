import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/jobs/index.ts',
	development: 'src/jobs/public/development.ts',
	production: 'src/jobs/public/production.ts',
	custom: 'src/jobs/public/custom.ts',
	memory: 'src/jobs/custom-backend-memory.ts',
	redis: 'src/jobs/backends-redis.ts',
	sql: 'src/jobs/backends-sql.ts',
	admin: 'src/jobs/admin.ts',
	observability: 'src/jobs/public/observability.ts',
	sqlMigration: 'src/jobs/migrations-sql.ts',
	redisMigration: 'src/jobs/migrations-redis.ts'
})
const SOURCE = Object.freeze({
	registration: 'src/jobs/index.ts',
	runtime: 'src/jobs/core/handler.ts',
	memory: 'src/jobs/features/backends/memory.ts',
	redis: 'src/jobs/features/backends/redis.ts',
	sql: 'src/jobs/features/backends/sql.ts',
	legacy: 'src/jobs/features/backends/legacy-migration.ts',
	sqlMigration: 'src/jobs/features/backends/sql-migration.ts',
	redisMigration: 'src/jobs/features/backends/redis-migration.ts',
	admin: 'src/jobs/admin.ts',
	observability: 'src/jobs/public/observability.ts'
})
const budget = (initial, brotli, total = initial, totalBrotli = brotli) => ({
	initialMinifiedLimit: initial, initialBrotliLimit: brotli,
	totalMinifiedLimit: total, totalBrotliLimit: totalBrotli
})
const SCENARIOS = Object.freeze([
	{name: 'root registration initial load', entries: [ENTRY.root], required: [SOURCE.registration],
		excluded: [SOURCE.runtime, SOURCE.memory, SOURCE.redis, SOURCE.sql, SOURCE.legacy], ...budget(4_000, 1_500, 111_000, 30_000)},
	{name: 'development', entries: [ENTRY.development], required: [SOURCE.runtime, SOURCE.memory],
		excluded: [SOURCE.redis, SOURCE.sql, SOURCE.legacy], ...budget(104_000, 28_000)},
	{name: 'production core', entries: [ENTRY.production], required: [SOURCE.runtime],
		excluded: [SOURCE.memory, SOURCE.redis, SOURCE.sql, SOURCE.legacy], ...budget(90_000, 23_000)},
	{name: 'custom core', entries: [ENTRY.custom], required: [SOURCE.runtime],
		excluded: [SOURCE.memory, SOURCE.redis, SOURCE.sql, SOURCE.legacy], ...budget(90_000, 23_000)},
	{name: 'memory backend', entries: [ENTRY.memory], required: [SOURCE.memory],
		excluded: [SOURCE.runtime, SOURCE.redis, SOURCE.sql, SOURCE.legacy], ...budget(62_000, 16_000)},
	{name: 'Redis backend', entries: [ENTRY.redis], required: [SOURCE.redis],
		excluded: [SOURCE.runtime, SOURCE.memory, SOURCE.sql, SOURCE.legacy, SOURCE.redisMigration], ...budget(120_000, 26_000)},
	{name: 'SQL backend', entries: [ENTRY.sql], required: [SOURCE.sql],
		excluded: [SOURCE.runtime, SOURCE.memory, SOURCE.redis, SOURCE.legacy, SOURCE.sqlMigration], ...budget(85_000, 22_000)},
	{name: 'admin contracts', entries: [ENTRY.admin], required: [SOURCE.admin],
		excluded: [SOURCE.runtime, SOURCE.memory, SOURCE.redis, SOURCE.sql], ...budget(1_000, 1_000)},
	{name: 'observability attachment', entries: [ENTRY.observability], required: [SOURCE.observability],
		excluded: [SOURCE.runtime, SOURCE.memory, SOURCE.redis, SOURCE.sql], ...budget(5_000, 2_000)},
	{name: 'SQL migration', entries: [ENTRY.sqlMigration], required: [SOURCE.sqlMigration, SOURCE.legacy],
		excluded: [SOURCE.runtime, SOURCE.memory, SOURCE.redis], ...budget(64_000, 16_000)},
	{name: 'Redis migration', entries: [ENTRY.redisMigration], required: [SOURCE.redisMigration, SOURCE.legacy],
		excluded: [SOURCE.runtime, SOURCE.memory, SOURCE.sql], ...budget(127_000, 28_000)}
])

const formatBytes = (bytes) => `${(bytes / 1_000).toFixed(2)} kB`
const resolveOutput = (outputs, byBase, path) => outputs[path] ? path : byBase.get(basename(path))
function collect(root, outputs, byBase, selected, includeDynamic) {
	if (!root || selected.has(root)) return
	selected.add(root)
	for (const item of outputs[root]?.imports ?? []) {
		if (item.external || (!includeDynamic && item.kind === 'dynamic-import')) continue
		collect(resolveOutput(outputs, byBase, item.path), outputs, byBase, selected, includeDynamic)
	}
}
function contributions(selected, outputs) {
	const values = new Map()
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) {
		values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
	}
	return [...values].map(([source, bytes]) => ({source, bytes}))
		.sort((left, right) => right.bytes - left.bytes || left.source.localeCompare(right.source))
}
async function sizes(selected, outputs, directory) {
	let minified = 0; let brotli = 0
	for (const output of selected) {
		const bytes = await readFile(join(directory, basename(output)))
		minified += Math.max(bytes.byteLength, outputs[output].bytes)
		brotli += brotliCompressSync(bytes, {params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 11}}).byteLength
	}
	return {minified, brotli}
}

const directory = await mkdtemp(join(tmpdir(), 'ooops-jobs-size-'))
try {
	await build({
		entry: ENTRY, format: ['esm'], platform: 'node', target: 'node22',
		external: ['@ooopsstudio/core', '@ooopsstudio/core/*'], splitting: true,
		treeshake: true, minify: true, dts: false, sourcemap: false, clean: true,
		outDir: directory, metafile: true, config: false, silent: true
	})
	const metafile = JSON.parse(await readFile(join(directory, 'metafile-esm.json'), 'utf8'))
	const outputs = metafile.outputs
	const byBase = new Map(Object.keys(outputs).map((output) => [basename(output), output]))
	const byEntry = new Map(Object.entries(outputs).filter(([, detail]) => detail.entryPoint)
		.map(([output, detail]) => [detail.entryPoint, output]))
	const results = []
	for (const scenario of SCENARIOS) {
		const initial = new Set(); const total = new Set()
		for (const entry of scenario.entries) {
			collect(byEntry.get(entry), outputs, byBase, initial, false)
			collect(byEntry.get(entry), outputs, byBase, total, true)
		}
		const included = new Set(contributions(initial, outputs).map(({source}) => source))
		for (const source of scenario.required ?? []) if (!included.has(source)) {
			throw new Error(`${scenario.name} is undercounting required source ${source}`)
		}
		for (const source of scenario.excluded ?? []) if (included.has(source)) {
			throw new Error(`${scenario.name} unexpectedly includes ${source}`)
		}
		results.push({...scenario, initial: await sizes(initial, outputs, directory),
			total: await sizes(total, outputs, directory), chunks: total.size,
			contributions: contributions(total, outputs)})
	}
	console.log('Jobs scenario size audit (workspace dependencies external)')
	console.log('Scenario | Initial min/Brotli | Total min/Brotli | Chunks | Budget')
	for (const result of results) {
		const pass = result.initial.minified <= result.initialMinifiedLimit
			&& result.initial.brotli <= result.initialBrotliLimit
			&& result.total.minified <= result.totalMinifiedLimit
			&& result.total.brotli <= result.totalBrotliLimit
		console.log(`${result.name} | ${formatBytes(result.initial.minified)}/${formatBytes(result.initial.brotli)} | ${formatBytes(result.total.minified)}/${formatBytes(result.total.brotli)} | ${result.chunks} | ${pass ? 'PASS' : 'FAIL'}`)
		if (process.argv.includes('--details')) for (const item of result.contributions.slice(0, 12)) {
			console.log(`  ${formatBytes(item.bytes)}  ${item.source}`)
		}
	}
	const failed = results.filter((result) => result.initial.minified > result.initialMinifiedLimit
		|| result.initial.brotli > result.initialBrotliLimit || result.total.minified > result.totalMinifiedLimit
		|| result.total.brotli > result.totalBrotliLimit)
	if (failed.length) throw new Error(`Jobs size budgets exceeded: ${failed.map(({name}) => name).join(', ')}`)
} finally { await rm(directory, {recursive: true, force: true}) }
