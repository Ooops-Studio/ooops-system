import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/rate-limit/index.ts',
	development: 'src/rate-limit/public/development.ts',
	production: 'src/rate-limit/public/production.ts',
	custom: 'src/rate-limit/public/custom.ts',
	http: 'src/rate-limit/http.ts',
	observability: 'src/rate-limit/public/observability.ts'
})
const SOURCE = Object.freeze({
	runtime: 'src/rate-limit/core/managed-handler.ts',
	policies: 'src/rate-limit/core/policy-registry.ts',
	fixedMemory: 'src/rate-limit/core/engines/fixed-window-memory.ts',
	fixedRedis: 'src/rate-limit/core/engines/fixed-window.ts',
	memoryToken: 'src/rate-limit/core/engines/token-bucket-memory.ts',
	redisToken: 'src/rate-limit/core/engines/token-bucket-redis.ts',
	redisCapability: 'src/rate-limit/core/redis-capability.ts',
	http: 'src/rate-limit/utils/http.ts',
	bridge: 'src/rate-limit/public/observability.ts'
})

const SCENARIOS = Object.freeze([
	{name: 'root registration', entry: ENTRY.root, initialMinified: 4_000, initialBrotli: 2_000,
		totalMinified: 36_400, totalBrotli: 12_000, requiredInitial: [ENTRY.root],
		excludedInitial: [SOURCE.runtime, SOURCE.fixedMemory, SOURCE.fixedRedis, SOURCE.memoryToken, SOURCE.redisToken]},
	{name: 'development memory', entry: ENTRY.development, initialMinified: 17_800, initialBrotli: 6_020, totalMinified: 17_800, totalBrotli: 6_020,
		requiredInitial: [SOURCE.runtime, SOURCE.policies, SOURCE.fixedMemory, SOURCE.memoryToken],
		excludedInitial: [SOURCE.fixedRedis, SOURCE.redisToken, SOURCE.redisCapability]},
	{name: 'production Redis', entry: ENTRY.production, initialMinified: 27_650, initialBrotli: 8_510, totalMinified: 27_650, totalBrotli: 8_510,
		requiredInitial: [SOURCE.runtime, SOURCE.policies, SOURCE.fixedRedis, SOURCE.redisToken, SOURCE.redisCapability],
		excludedInitial: [SOURCE.fixedMemory, SOURCE.memoryToken]},
	{name: 'custom composition', entry: ENTRY.custom, initialMinified: 30_100, initialBrotli: 9_440, totalMinified: 30_100, totalBrotli: 9_440,
		requiredInitial: [SOURCE.runtime, SOURCE.fixedRedis, SOURCE.memoryToken, SOURCE.redisToken]},
	{name: 'HTTP helpers', entry: ENTRY.http, initialMinified: 2_250, initialBrotli: 1_000, totalMinified: 2_250, totalBrotli: 1_000,
		requiredInitial: [SOURCE.http], excludedInitial: [SOURCE.runtime, SOURCE.fixedMemory, SOURCE.fixedRedis]},
	{name: 'observability bridge', entry: ENTRY.observability, initialMinified: 2_000, initialBrotli: 1_000, totalMinified: 2_000, totalBrotli: 1_000,
		requiredInitial: [SOURCE.bridge], excludedInitial: [SOURCE.runtime, SOURCE.fixedMemory, SOURCE.fixedRedis]}
])

const format = (bytes) => `${(bytes / 1_000).toFixed(2)} kB`
const resolveOutput = (outputs, byBase, path) => outputs[path] ? path : byBase.get(basename(path))
function collect(root, outputs, byBase, selected, dynamic) {
	if (!root || selected.has(root)) return
	selected.add(root)
	for (const item of outputs[root]?.imports ?? []) {
		if (item.external || (!dynamic && item.kind === 'dynamic-import')) continue
		collect(resolveOutput(outputs, byBase, item.path), outputs, byBase, selected, dynamic)
	}
}
function contributions(selected, outputs) {
	const values = new Map()
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) {
		values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
	}
	return [...values].map(([source, bytes]) => ({source, bytes})).sort((a, b) => b.bytes - a.bytes || a.source.localeCompare(b.source))
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

const directory = await mkdtemp(join(tmpdir(), 'ooops-rate-limit-size-'))
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
	const byEntry = new Map(Object.entries(outputs)
		.filter(([, value]) => value.entryPoint)
		.map(([output, value]) => [value.entryPoint, output]))
	const results = []
	for (const scenario of SCENARIOS) {
		const initial = new Set(); const total = new Set()
		collect(byEntry.get(scenario.entry), outputs, byBase, initial, false)
		collect(byEntry.get(scenario.entry), outputs, byBase, total, true)
		const initialRows = contributions(initial, outputs)
		const initialSources = new Set(initialRows.map(({source}) => source))
		for (const source of scenario.requiredInitial ?? []) if (!initialSources.has(source)) throw new Error(`${scenario.name} undercounts ${source}`)
		for (const source of scenario.excludedInitial ?? []) if (initialSources.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
		results.push({
			...scenario,
			initial: await sizes(initial, outputs, directory),
			total: await sizes(total, outputs, directory),
			chunks: total.size,
			contributions: contributions(total, outputs)
		})
	}
	if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
	else {
		console.log('Rate-limit scenario/metafile audit (workspace dependencies external)')
		console.log('Scenario | Initial min/Br | Total min/Br | Chunks | Budgets')
		for (const result of results) {
			const pass = result.initial.minified <= result.initialMinified
				&& result.initial.brotli <= result.initialBrotli
				&& result.total.minified <= result.totalMinified
				&& result.total.brotli <= result.totalBrotli
			console.log(`${result.name} | ${format(result.initial.minified)}/${format(result.initial.brotli)}`
				+ ` | ${format(result.total.minified)}/${format(result.total.brotli)} | ${result.chunks}`
				+ ` | ${format(result.initialMinified)}/${format(result.initialBrotli)} initial;`
				+ ` ${format(result.totalMinified)}/${format(result.totalBrotli)} total ${pass ? 'PASS' : 'FAIL'}`)
			if (process.argv.includes('--details')) for (const row of result.contributions.slice(0, 12)) console.log(`  ${format(row.bytes)}  ${row.source}`)
		}
	}
	const failed = results.filter((result) => result.initial.minified > result.initialMinified
		|| result.initial.brotli > result.initialBrotli
		|| result.total.minified > result.totalMinified
		|| result.total.brotli > result.totalBrotli)
	if (failed.length) throw new Error(`Rate-limit size budgets exceeded: ${failed.map(({name}) => name).join(', ')}`)
} finally { await rm(directory, {recursive: true, force: true}) }
