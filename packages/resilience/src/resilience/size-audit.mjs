import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/resilience/index.ts',
	development: 'src/resilience/public/development.ts',
	production: 'src/resilience/public/production.ts',
	custom: 'src/resilience/public/custom.ts',
	classifiers: 'src/resilience/core/classifiers.ts'
})
const SOURCE = Object.freeze({
	runtime: 'src/resilience/core/managed-runtime.ts',
	coalescing: 'src/resilience/core/managed-runtime.ts',
	fallback: 'src/resilience/core/custom-fallback.ts'
})
const SCENARIOS = Object.freeze([
	{name: 'root registration initial load', entry: ENTRY.root, minified: 4_000, brotli: 2_000, excluded: [ENTRY.development, ENTRY.production, ENTRY.custom, SOURCE.runtime, SOURCE.fallback]},
	{name: 'development', entry: ENTRY.development, minified: 34_250, brotli: 10_100, required: [SOURCE.runtime], excluded: [SOURCE.fallback]},
	{name: 'production', entry: ENTRY.production, minified: 34_250, brotli: 10_100, required: [SOURCE.runtime], excluded: [SOURCE.fallback]},
	{name: 'custom core', entry: ENTRY.custom, minified: 37_750, brotli: 11_200, required: [SOURCE.runtime, SOURCE.fallback]},
	{name: 'standard coalescing', entry: ENTRY.production, minified: 34_250, brotli: 10_100, required: [SOURCE.coalescing], excluded: [SOURCE.fallback]},
	{name: 'custom fallback', entry: ENTRY.custom, minified: 37_750, brotli: 11_200, required: [SOURCE.fallback]},
	{name: 'classifier helpers only', entry: ENTRY.classifiers, minified: 2_000, brotli: 1_000, excluded: [SOURCE.runtime, SOURCE.fallback]}
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
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
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
	const initialSize = await sizes(initial, outputs, directory); const totalSize = await sizes(total, outputs, directory)
	const sourceRows = contributions(total, outputs); const sources = new Set(sourceRows.map(({source}) => source))
	for (const source of scenario.required ?? []) if (!sources.has(source)) throw new Error(`${scenario.name} undercounts ${source}`)
	for (const source of scenario.excluded ?? []) if (sources.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
	return {...scenario, initial: initialSize, total: totalSize, chunks: total.size, contributions: sourceRows}
}

const directory = await mkdtemp(join(tmpdir(), 'ooops-resilience-size-'))
try {
	await build({entry: ENTRY, format: ['esm'], platform: 'node', target: 'node22', external: ['@ooopsstudio/core', '@ooopsstudio/core/*'], splitting: true, treeshake: true, minify: true, dts: false, sourcemap: false, clean: true, outDir: directory, metafile: true, config: false, silent: true})
	const metafile = JSON.parse(await readFile(join(directory, 'metafile-esm.json'), 'utf8')); const outputs = metafile.outputs
	const byBase = new Map(Object.keys(outputs).map((output) => [basename(output), output]))
	const byEntry = new Map(Object.entries(outputs).filter(([, value]) => value.entryPoint).map(([output, value]) => [value.entryPoint, output]))
	const results = []
	for (const scenario of SCENARIOS) results.push(await measure(scenario, outputs, byEntry, byBase, directory))
	if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
	else {
		console.log('Resilience scenario/metafile audit (workspace dependencies external)')
		console.log('Scenario | Initial min/Br | Total min/Br | Chunks | Budgets')
		for (const result of results) {
			const pass = result.total.minified <= result.minified && result.total.brotli <= result.brotli
			console.log(`${result.name} | ${format(result.initial.minified)}/${format(result.initial.brotli)} | ${format(result.total.minified)}/${format(result.total.brotli)} | ${result.chunks} | ${format(result.minified)}/${format(result.brotli)} ${pass ? 'PASS' : 'FAIL'}`)
			if (process.argv.includes('--details')) for (const row of result.contributions.slice(0, 12)) console.log(`  ${format(row.bytes)}  ${row.source}`)
		}
	}
	const failed = results.filter((result) => result.total.minified > result.minified || result.total.brotli > result.brotli)
	if (failed.length) throw new Error(`Resilience size budgets exceeded: ${failed.map(({name}) => name).join(', ')}`)
} finally { await rm(directory, {recursive: true, force: true}) }
