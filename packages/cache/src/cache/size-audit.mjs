import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/cache/index.ts',
	development: 'src/cache/public/development.ts',
	production: 'src/cache/public/production.ts',
	custom: 'src/cache/public/custom.ts'
})

const SOURCE = Object.freeze({
	handler: 'src/cache/core/handler-runtime.ts',
	operations: 'src/cache/core/runtime-operations.ts',
	memory: 'src/cache/features/backends/memory.ts',
	redis: 'src/cache/features/backends/redis-implementation.ts',
	redisScripts: 'src/cache/features/backends/redis-scripts.ts',
	registration: 'src/cache/index.ts'
})

const SCENARIOS = Object.freeze([
	{name: 'root registration initial load', entries: [ENTRY.root],
		required: [SOURCE.registration], excluded: [SOURCE.handler, SOURCE.memory, SOURCE.redis],
		initialMinifiedLimit: 4_000, initialBrotliLimit: 2_000,
		totalMinifiedLimit: 58_000, totalBrotliLimit: 17_000},
	{name: 'development memory', entries: [ENTRY.development],
		required: [SOURCE.handler, SOURCE.operations, SOURCE.memory], excluded: [SOURCE.redis, SOURCE.redisScripts],
		initialMinifiedLimit: 43_000, initialBrotliLimit: 12_000,
		totalMinifiedLimit: 43_000, totalBrotliLimit: 12_000},
	{name: 'production Redis', entries: [ENTRY.production],
		required: [SOURCE.handler, SOURCE.operations, SOURCE.redis, SOURCE.redisScripts], excluded: [SOURCE.memory],
		initialMinifiedLimit: 50_000, initialBrotliLimit: 14_000,
		totalMinifiedLimit: 50_000, totalBrotliLimit: 14_000},
	{name: 'custom backend core', entries: [ENTRY.custom],
		required: [SOURCE.handler, SOURCE.operations], excluded: [SOURCE.memory, SOURCE.redis, SOURCE.redisScripts],
		initialMinifiedLimit: 39_000, initialBrotliLimit: 11_000,
		totalMinifiedLimit: 39_000, totalBrotliLimit: 11_000}
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

function sourceContributions(selected, outputs) {
	const values = new Map()
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) {
		values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
	}
	return [...values].map(([source, bytes]) => ({source, bytes}))
		.sort((left, right) => right.bytes - left.bytes || left.source.localeCompare(right.source))
}

async function bytesFor(selected, outputs, directory) {
	let minified = 0
	let brotli = 0
	for (const output of selected) {
		const bytes = await readFile(join(directory, basename(output)))
		minified += Math.max(bytes.byteLength, outputs[output].bytes)
		brotli += brotliCompressSync(bytes, {
			params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 11}
		}).byteLength
	}
	return {minified, brotli}
}

const directory = await mkdtemp(join(tmpdir(), 'ooops-cache-size-'))
try {
	await build({
		entry: ENTRY,
		format: ['esm'], platform: 'node', target: 'node22',
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
		const initial = new Set()
		const total = new Set()
		for (const entry of scenario.entries) {
			collect(byEntry.get(entry), outputs, byBase, initial, false)
			collect(byEntry.get(entry), outputs, byBase, total, true)
		}
		const contributions = sourceContributions(initial, outputs)
		const included = new Set(contributions.map(({source}) => source))
		for (const source of scenario.required ?? []) {
			if (!included.has(source)) throw new Error(`${scenario.name} is undercounting required source ${source}`)
		}
		for (const source of scenario.excluded ?? []) {
			if (included.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
		}
		results.push({
			...scenario,
			initial: await bytesFor(initial, outputs, directory),
			total: await bytesFor(total, outputs, directory),
			chunks: total.size,
			contributions: sourceContributions(total, outputs)
		})
	}
	if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
	else {
		console.log('Cache scenario size audit (workspace dependencies external)')
		console.log('Scenario | Initial min/Brotli | Total min/Brotli | Chunks | Budget')
		for (const result of results) {
			const pass = result.initial.minified <= result.initialMinifiedLimit
				&& result.initial.brotli <= result.initialBrotliLimit
				&& result.total.minified <= result.totalMinifiedLimit
				&& result.total.brotli <= result.totalBrotliLimit
			console.log(`${result.name} | ${formatBytes(result.initial.minified)}/${formatBytes(result.initial.brotli)} | ${formatBytes(result.total.minified)}/${formatBytes(result.total.brotli)} | ${result.chunks} | ${formatBytes(result.initialMinifiedLimit)}/${formatBytes(result.initialBrotliLimit)} initial; ${formatBytes(result.totalMinifiedLimit)}/${formatBytes(result.totalBrotliLimit)} total ${pass ? 'PASS' : 'FAIL'}`)
			if (process.argv.includes('--details')) for (const item of result.contributions.slice(0, 12)) {
				console.log(`  ${formatBytes(item.bytes)}  ${item.source}`)
			}
		}
	}
	const failures = results.filter((result) =>
		result.initial.minified > result.initialMinifiedLimit
		|| result.initial.brotli > result.initialBrotliLimit
		|| result.total.minified > result.totalMinifiedLimit
		|| result.total.brotli > result.totalBrotliLimit)
	if (failures.length) throw new Error(`Cache size budgets exceeded: ${failures.map(({name}) => name).join(', ')}`)
} finally {
	await rm(directory, {recursive: true, force: true})
}
