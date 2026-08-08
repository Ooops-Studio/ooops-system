/* eslint-disable @stylistic/max-len -- scenario tables stay readable as one row per path */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/index.ts', development: 'src/public/development.ts',
	production: 'src/public/production.ts', custom: 'src/public/custom.ts',
	inspector: 'src/profilers-inspector.ts', pyroscope: 'src/providers-pyroscope.ts',
	console: 'src/exporters-console.ts', memory: 'src/exporters-memory.ts'
})
const SOURCE = Object.freeze({
	manager: 'src/manager.ts', inspector: 'src/inspector-profiler.ts',
	pyroscope: 'src/pyroscope-provider.ts', console: 'src/console-exporter.ts',
	memory: 'src/memory-exporter.ts'
})
const SCENARIOS = Object.freeze([
	{name: 'root registration initial load', entries: [ENTRY.root], followDynamic: false, limit: 1_000, brotliLimit: 1_000,
		excluded: [SOURCE.manager, SOURCE.inspector, SOURCE.pyroscope, SOURCE.console, SOURCE.memory]},
	// Cross-copy and cross-layer native ownership fences are security-critical
	// and intentionally counted in compositions and direct provider bundles.
	{name: 'development', entries: [ENTRY.development], followDynamic: true, limit: 25_300, brotliLimit: 9_100,
		required: [SOURCE.manager, SOURCE.inspector, SOURCE.console], excluded: [SOURCE.pyroscope]},
	{name: 'production core', entries: [ENTRY.production], followDynamic: true, limit: 18_000, brotliLimit: 6_000,
		required: [SOURCE.manager], excluded: [SOURCE.inspector, SOURCE.pyroscope]},
	// Keep a narrow allowance for process-wide rollback and mandatory credential redaction.
	{name: 'custom continuous provider', entries: [ENTRY.custom], followDynamic: true, limit: 18_100, brotliLimit: 6_150,
		required: [SOURCE.manager], excluded: [SOURCE.inspector, SOURCE.pyroscope, SOURCE.console, SOURCE.memory]},
	{name: 'custom Inspector with exporter', entries: [ENTRY.custom, ENTRY.inspector, ENTRY.memory], followDynamic: true, limit: 27_200, brotliLimit: 10_000,
		required: [SOURCE.manager, SOURCE.inspector, SOURCE.memory], excluded: [SOURCE.pyroscope]},
	{name: 'custom + one exporter', entries: [ENTRY.custom, ENTRY.memory], followDynamic: true, limit: 22_000, brotliLimit: 8_000,
		required: [SOURCE.manager, SOURCE.memory], excluded: [SOURCE.inspector, SOURCE.pyroscope, SOURCE.console]},
	{name: 'custom + two exporters', entries: [ENTRY.custom, ENTRY.memory, ENTRY.console], followDynamic: true, limit: 23_000, brotliLimit: 8_000,
		required: [SOURCE.manager, SOURCE.memory, SOURCE.console], excluded: [SOURCE.inspector, SOURCE.pyroscope]},
	{name: 'Inspector only', entries: [ENTRY.inspector], followDynamic: true, limit: 10_000, brotliLimit: 4_000,
		required: [SOURCE.inspector], excluded: [SOURCE.manager, SOURCE.pyroscope, SOURCE.console, SOURCE.memory]},
	{name: 'Pyroscope only', entries: [ENTRY.pyroscope], followDynamic: true, limit: 9_000, brotliLimit: 3_000,
		required: [SOURCE.pyroscope], excluded: [SOURCE.manager, SOURCE.inspector]},
	{name: 'console exporter', entries: [ENTRY.console], followDynamic: true, limit: 5_000, brotliLimit: 3_000,
		required: [SOURCE.console], excluded: [SOURCE.manager, SOURCE.inspector, SOURCE.pyroscope]},
	{name: 'memory exporter', entries: [ENTRY.memory], followDynamic: true, limit: 7_000, brotliLimit: 3_000,
		required: [SOURCE.memory], excluded: [SOURCE.manager, SOURCE.inspector, SOURCE.pyroscope]}
])

const formatBytes = (bytes) => `${(bytes / 1_000).toFixed(2)} kB`
const resolveOutput = (outputs, byBase, path) => outputs[path] ? path : byBase.get(basename(path))
function collect(root, outputs, byBase, selected, followDynamic) {
	if (!root || selected.has(root)) return
	selected.add(root)
	for (const item of outputs[root]?.imports ?? []) {
		if (item.external || (!followDynamic && item.kind === 'dynamic-import')) continue
		collect(resolveOutput(outputs, byBase, item.path), outputs, byBase, selected, followDynamic)
	}
}
function contributions(selected, outputs) {
	const values = new Map()
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
	return [...values].map(([source, bytes]) => ({source, bytes})).sort((a, b) => b.bytes - a.bytes || a.source.localeCompare(b.source))
}
async function measure(scenario, outputs, byEntry, byBase, directory) {
	const initial = new Set(); for (const entry of scenario.entries) collect(byEntry.get(entry), outputs, byBase, initial, false)
	const total = new Set(); for (const entry of scenario.entries) collect(byEntry.get(entry), outputs, byBase, total, scenario.followDynamic)
	const totals = async(selected) => {
		let minified = 0; let brotli = 0
		for (const output of selected) { const bytes = await readFile(join(directory, basename(output))); minified += Math.max(bytes.byteLength, outputs[output].bytes); brotli += brotliCompressSync(bytes, {params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 11}}).byteLength }
		return {minified, brotli}
	}
	const sourceContributions = contributions(total, outputs); const included = new Set(sourceContributions.map(({source}) => source))
	for (const source of scenario.required ?? []) if (!included.has(source)) throw new Error(`${scenario.name} is undercounting ${source}`)
	for (const source of scenario.excluded ?? []) if (included.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
	return {name: scenario.name, initial: await totals(initial), total: await totals(total), chunks: total.size, limit: scenario.limit, brotliLimit: scenario.brotliLimit, contributions: sourceContributions}
}

const directory = await mkdtemp(join(tmpdir(), 'ooops-profiling-size-'))
try {
	await build({entry: ENTRY, format: ['esm'], platform: 'node', target: 'node22', external: ['@ooopsstudio/core', '@ooopsstudio/core/*', '@pyroscope/nodejs'], splitting: true, treeshake: true, minify: true, dts: false, sourcemap: false, clean: true, outDir: directory, metafile: true, config: false, silent: true})
	const metafile = JSON.parse(await readFile(join(directory, 'metafile-esm.json'), 'utf8')); const outputs = metafile.outputs
	const byBase = new Map(Object.keys(outputs).map((output) => [basename(output), output]))
	const byEntry = new Map(Object.entries(outputs).filter(([, detail]) => detail.entryPoint).map(([output, detail]) => [detail.entryPoint, output]))
	const results = []; for (const scenario of SCENARIOS) results.push(await measure(scenario, outputs, byEntry, byBase, directory))
	if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
	else {
		console.log('Profiling scenario size audit (workspace dependencies external)')
		console.log('Scenario | Initial min/Brotli | Total min/Brotli | Chunks | Budget')
		for (const result of results) {
			const state = result.total.minified <= result.limit && result.total.brotli <= result.brotliLimit ? 'PASS' : 'FAIL'
			console.log(`${result.name} | ${formatBytes(result.initial.minified)}/${formatBytes(result.initial.brotli)} | ${formatBytes(result.total.minified)}/${formatBytes(result.total.brotli)} | ${result.chunks} | ${formatBytes(result.limit)}/${formatBytes(result.brotliLimit)} ${state}`)
			if (process.argv.includes('--details')) for (const item of result.contributions.slice(0, 12)) console.log(`  ${formatBytes(item.bytes)}  ${item.source}`)
		}
	}
	const failures = results.filter((result) => result.total.minified > result.limit || result.total.brotli > result.brotliLimit)
	if (failures.length) throw new Error(`Profiling size budgets exceeded: ${failures.map(({name}) => name).join(', ')}`)
} finally { await rm(directory, {recursive: true, force: true}) }
