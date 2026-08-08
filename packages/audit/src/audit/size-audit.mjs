import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/audit/index.ts',
	development: 'src/audit/public/development.ts',
	production: 'src/audit/public/production.ts',
	custom: 'src/audit/public/custom.ts',
	adminContracts: 'src/audit/admin.ts'
})
const FEATURE = Object.freeze({
	admin: 'src/audit/core/admin.ts',
	export: 'src/audit/core/query-export.ts',
	archive: 'src/audit/core/admin-archive.ts',
	postgresVerification: 'src/audit/features/stores/postgres-verification.ts',
	postgresRetention: 'src/audit/features/stores/postgres-retention.ts'
})

const SCENARIOS = Object.freeze([
	{name: 'root registration initial', entry: ENTRY.root, dynamic: [], budget: {minified: 3_800, brotli: 1_450, totalMinified: 121_300, totalBrotli: 38_000},
		excluded: [ENTRY.development, ENTRY.production, ENTRY.custom]},
	{name: 'development core', entry: ENTRY.development, dynamic: [], budget: {minified: 57_700, brotli: 17_400, totalMinified: 68_100, totalBrotli: 21_000}, excluded: [FEATURE.admin, FEATURE.export]},
	{name: 'production write/query', entry: ENTRY.production, dynamic: [], budget: {minified: 80_900, brotli: 24_100, totalMinified: 101_700, totalBrotli: 31_200},
		excluded: [FEATURE.admin, FEATURE.export, FEATURE.postgresVerification, FEATURE.postgresRetention]},
	{name: 'production transactional', entry: ENTRY.production, dynamic: [], budget: {minified: 80_900, brotli: 24_100, totalMinified: 101_700, totalBrotli: 31_200}},
	{name: 'production admin verification', entry: ENTRY.production, dynamic: [FEATURE.admin, FEATURE.postgresVerification], budget: {minified: 93_200, brotli: 27_800, totalMinified: 101_700, totalBrotli: 31_200},
		required: [FEATURE.admin, FEATURE.postgresVerification]},
	{name: 'custom core', entry: ENTRY.custom, dynamic: [], budget: {minified: 58_500, brotli: 17_200, totalMinified: 69_300, totalBrotli: 21_000}, excluded: [FEATURE.admin, FEATURE.archive]},
	{name: 'custom transactional', entry: ENTRY.custom, dynamic: [], budget: {minified: 58_500, brotli: 17_200, totalMinified: 69_300, totalBrotli: 21_000}},
	{name: 'custom admin', entry: ENTRY.custom, dynamic: [FEATURE.admin], budget: {minified: 65_700, brotli: 19_300, totalMinified: 69_300, totalBrotli: 21_000}, required: [FEATURE.admin]},
	{name: 'custom archive', entry: ENTRY.custom, dynamic: [FEATURE.admin, FEATURE.archive], budget: {minified: 66_100, brotli: 19_550, totalMinified: 69_300, totalBrotli: 21_000}, required: [FEATURE.admin, FEATURE.archive]},
	{name: 'admin contracts', entry: ENTRY.adminContracts, dynamic: [], budget: {minified: 1_000, brotli: 1_000, totalMinified: 1_000, totalBrotli: 1_000},
		required: [ENTRY.adminContracts]}
])

const formatBytes = (bytes) => `${(bytes / 1_000).toFixed(2)} kB`
const resolveOutput = (outputs, byBasename, path) => outputs[path] ? path : byBasename.get(basename(path))

function collect(root, outputs, byBasename, selected, followDynamic) {
	if (!root || selected.has(root)) return
	selected.add(root)
	for (const imported of outputs[root]?.imports ?? []) {
		if (imported.external || (!followDynamic && imported.kind === 'dynamic-import')) continue
		collect(resolveOutput(outputs, byBasename, imported.path), outputs, byBasename, selected, followDynamic)
	}
}

function contributions(selected, outputs) {
	const values = new Map()
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) {
		values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
	}
	return [...values.entries()].map(([source, bytes]) => ({source, bytes}))
		.sort((a, b) => b.bytes - a.bytes || a.source.localeCompare(b.source))
}

async function byteTotals(selected, outputs, directory) {
	let minified = 0
	let brotli = 0
	for (const output of selected) {
		const bytes = await readFile(join(directory, basename(output)))
		minified += Math.max(bytes.byteLength, outputs[output].bytes)
		brotli += brotliCompressSync(bytes, {params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 11}}).byteLength
	}
	return {minified, brotli}
}

async function measure(scenario, outputs, byEntry, byBasename, directory) {
	const initial = new Set()
	const roots = [scenario.entry, ...scenario.dynamic]
	for (const source of roots) {
		const output = byEntry.get(source)
		if (!output) throw new Error(`Audit size audit could not find output for ${source}`)
		collect(output, outputs, byBasename, initial, false)
	}
	const total = new Set()
	for (const source of roots) collect(byEntry.get(source), outputs, byBasename, total, true)
	const sourceSet = new Set(contributions(initial, outputs).map(({source}) => source))
	for (const source of scenario.required ?? []) if (!sourceSet.has(source)) throw new Error(`${scenario.name} is undercounting ${source}`)
	for (const source of scenario.excluded ?? []) if (sourceSet.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
	return {
		name: scenario.name,
		initial: await byteTotals(initial, outputs, directory),
		total: await byteTotals(total, outputs, directory),
		chunks: {initial: initial.size, total: total.size},
		budget: scenario.budget,
		contributions: contributions(initial, outputs)
	}
}

async function run() {
	const directory = await mkdtemp(join(tmpdir(), 'ooops-audit-size-'))
	try {
		await build({
			entry: ENTRY, format: ['esm'], platform: 'node', target: 'node22',
			external: ['@ooopsstudio/core', '@ooopsstudio/core/*'], splitting: true,
			treeshake: true, minify: true, dts: false, sourcemap: false, clean: true,
			outDir: directory, metafile: true, config: false, silent: true
		})
		const metafile = JSON.parse(await readFile(join(directory, 'metafile-esm.json'), 'utf8'))
		const outputs = metafile.outputs
		const byBasename = new Map(Object.keys(outputs).map((output) => [basename(output), output]))
		const byEntry = new Map(Object.entries(outputs).filter(([, value]) => typeof value.entryPoint === 'string')
			.map(([output, value]) => [value.entryPoint, output]))
		const results = []
		for (const scenario of SCENARIOS) results.push(await measure(scenario, outputs, byEntry, byBasename, directory))
		if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
		else {
			console.log('Audit scenario size audit (workspace dependencies external)')
			console.log('Scenario | Initial min | Initial br | Total min | Total br | Chunks | Budget')
			for (const result of results) {
				const pass = result.initial.minified <= result.budget.minified && result.initial.brotli <= result.budget.brotli
					&& result.total.minified <= result.budget.totalMinified && result.total.brotli <= result.budget.totalBrotli
				console.log(`${result.name} | ${formatBytes(result.initial.minified)} | ${formatBytes(result.initial.brotli)} | ${formatBytes(result.total.minified)} | ${formatBytes(result.total.brotli)} | ${result.chunks.initial}/${result.chunks.total} | ${pass ? 'PASS' : 'FAIL'}`)
				if (process.argv.includes('--details')) for (const item of result.contributions.slice(0, 12)) console.log(`  ${formatBytes(item.bytes)}  ${item.source}`)
			}
		}
		const failures = results.filter((result) => result.initial.minified > result.budget.minified
			|| result.initial.brotli > result.budget.brotli || result.total.minified > result.budget.totalMinified
			|| result.total.brotli > result.budget.totalBrotli)
		if (failures.length) throw new Error(`Audit size budgets exceeded: ${failures.map(({name}) => name).join(', ')}`)
	} finally { await rm(directory, {recursive: true, force: true}) }
}

await run()
