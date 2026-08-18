import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/performance/index.ts', development: 'src/performance/public/development.ts',
	production: 'src/performance/public/production.ts', custom: 'src/performance/public/custom.ts',
	raw: 'src/performance/public/custom-exporters-raw.ts', http: 'src/performance/public/custom-exporters-http.ts'
})
const OPTIONAL = Object.freeze({
	monitors: 'src/performance/core/runtime/monitors.ts', budgets: 'src/performance/features/core/budget-engine.ts',
	n1: 'src/performance/features/db/n1-detector.ts', delivery: 'src/performance/core/event-export-manager.ts'
})
const SCENARIOS = Object.freeze([
	{name: 'root registration initial load', entry: ENTRY.root, optional: [], minified: 4_500, brotli: 1_750,
		excluded: [ENTRY.development, ENTRY.production, ENTRY.custom]},
	{name: 'development core', entry: ENTRY.development, optional: [OPTIONAL.monitors], minified: 37_300, brotli: 13_000,
		excluded: [OPTIONAL.budgets, OPTIONAL.n1, OPTIONAL.delivery]},
	{name: 'production core', entry: ENTRY.production, optional: [OPTIONAL.monitors], minified: 37_150, brotli: 12_950,
		excluded: [OPTIONAL.budgets, OPTIONAL.n1, OPTIONAL.delivery]},
	{name: 'custom measurement-only', entry: ENTRY.custom, optional: [], minified: 33_200, brotli: 11_570,
		excluded: [OPTIONAL.monitors, OPTIONAL.budgets, OPTIONAL.n1, OPTIONAL.delivery]},
	{name: 'custom + budgets', entry: ENTRY.custom, optional: [OPTIONAL.budgets], minified: 36_300, brotli: 12_850, required: [OPTIONAL.budgets]},
	{name: 'custom + trace-scoped N+1', entry: ENTRY.custom, optional: [OPTIONAL.n1], minified: 38_150, brotli: 13_450, required: [OPTIONAL.n1]},
	{name: 'custom + raw exporter', entry: ENTRY.custom, optional: [OPTIONAL.delivery], minified: 46_850, brotli: 16_300, required: [OPTIONAL.delivery]},
	{name: 'custom + two exporters', entry: ENTRY.custom, optional: [OPTIONAL.delivery], minified: 46_850, brotli: 16_300, required: [OPTIONAL.delivery]},
	{name: 'standalone HTTP exporter', entry: ENTRY.http, optional: [], minified: 10_900, brotli: 4_000,
		excluded: [ENTRY.custom, OPTIONAL.monitors, OPTIONAL.budgets, OPTIONAL.n1, OPTIONAL.delivery]}
])

const format = (bytes) => `${(bytes / 1_000).toFixed(2)} kB`
const resolveOutput = (outputs, byBase, path) => outputs[path] ? path : byBase.get(basename(path))
function collectStatic(root, outputs, byBase, selected) {
	if (!root || selected.has(root)) return
	selected.add(root)
	for (const imported of outputs[root]?.imports ?? []) {
		if (imported.external || imported.kind === 'dynamic-import') continue
		collectStatic(resolveOutput(outputs, byBase, imported.path), outputs, byBase, selected)
	}
}
function contributions(selected, outputs) {
	const values = new Map()
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) {
		values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
	}
	return [...values].map(([source, bytes]) => ({source, bytes})).sort((a, b) => b.bytes - a.bytes)
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
async function measure(scenario, outputs, byEntry, byBase, directory) {
	const initial = new Set(); collectStatic(byEntry.get(scenario.entry), outputs, byBase, initial)
	const total = new Set(initial)
	for (const source of scenario.optional) {
		const output = byEntry.get(source)
		if (!output) throw new Error(`Performance audit cannot find optional chunk ${source}`)
		collectStatic(output, outputs, byBase, total)
	}
	const initialSize = await sizes(initial, outputs, directory); const totalSize = await sizes(total, outputs, directory)
	const sourceRows = contributions(total, outputs); const sources = new Set(sourceRows.map(({source}) => source))
	for (const source of scenario.required ?? []) if (!sources.has(source)) throw new Error(`${scenario.name} undercounts ${source}`)
	for (const source of scenario.excluded ?? []) if (sources.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
	return {...scenario, initial: initialSize, total: totalSize, chunks: total.size, contributions: sourceRows}
}

const directory = await mkdtemp(join(tmpdir(), 'ooops-performance-size-'))
try {
	await build({entry: ENTRY, format: ['esm'], platform: 'node', target: 'node22',
		external: ['@ooopsstudio/core', '@ooopsstudio/core/*'], splitting: true, treeshake: true,
		minify: true, dts: false, sourcemap: false, clean: true, outDir: directory,
		metafile: true, config: false, silent: true})
	const metafile = JSON.parse(await readFile(join(directory, 'metafile-esm.json'), 'utf8')); const outputs = metafile.outputs
	const byBase = new Map(Object.keys(outputs).map((output) => [basename(output), output]))
	const byEntry = new Map(Object.entries(outputs)
		.filter(([, value]) => value.entryPoint)
		.map(([output, value]) => [value.entryPoint, output]))
	const results = []
	for (const scenario of SCENARIOS) results.push(await measure(scenario, outputs, byEntry, byBase, directory))
	if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
	else {
		console.log('Performance scenario/metafile audit (workspace dependencies external)')
		console.log('Scenario | Initial min/Br | Total min/Br | Chunks | Budgets')
		for (const result of results) {
			const pass = result.total.minified <= result.minified && result.total.brotli <= result.brotli
			console.log(`${result.name} | ${format(result.initial.minified)}/${format(result.initial.brotli)} | ${format(result.total.minified)}/${format(result.total.brotli)} | ${result.chunks} | ${format(result.minified)}/${format(result.brotli)} ${pass ? 'PASS' : 'FAIL'}`)
			if (process.argv.includes('--details')) for (const row of result.contributions.slice(0, 12)) console.log(`  ${format(row.bytes)}  ${row.source}`)
		}
	}
	const failed = results.filter((result) => result.total.minified > result.minified || result.total.brotli > result.brotli)
	if (failed.length) throw new Error(`Performance size budgets exceeded: ${failed.map(({name}) => name).join(', ')}`)
} finally { await rm(directory, {recursive: true, force: true}) }
