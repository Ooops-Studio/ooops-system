import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	development: 'src/public/development.ts',
	production: 'src/public/production.ts',
	custom: 'src/public/custom.ts',
	sentry: 'src/sentry.ts'
})

const SENTRY_SOURCES = Object.freeze([
	'src/sinks/providers/sentry.ts',
	'src/sinks/providers/sentry-dsn.ts',
	'src/sinks/providers/sentry-event.ts',
	'src/sinks/providers/sentry-sanitization.ts'
])

const SCENARIOS = Object.freeze([
	{name: 'development default', entries: [ENTRY.development], minifiedLimit: 47_500, brotliLimit: 14_500,
		excluded: SENTRY_SOURCES},
	{name: 'production core', entries: [ENTRY.production], minifiedLimit: 47_500, brotliLimit: 14_500,
		excluded: SENTRY_SOURCES},
	{name: 'custom core', entries: [ENTRY.custom], minifiedLimit: 47_000, brotliLimit: 14_400,
		excluded: SENTRY_SOURCES},
	{name: 'Sentry standalone', entries: [ENTRY.sentry], minifiedLimit: 27_000, brotliLimit: 9_000,
		required: SENTRY_SOURCES},
	{name: 'production + Sentry', entries: [ENTRY.production, ENTRY.sentry],
		minifiedLimit: 61_000, brotliLimit: 19_200, required: SENTRY_SOURCES}
])

const formatBytes = (bytes) => `${(bytes / 1_000).toFixed(2)} kB`
const resolveOutput = (outputs, byBasename, path) => outputs[path]
	? path
	: byBasename.get(basename(path))

function collectOutputs(root, outputs, byBasename, selected, includeDynamic) {
	if (!root || selected.has(root)) return
	selected.add(root)
	for (const imported of outputs[root]?.imports ?? []) {
		if (imported.external || (!includeDynamic && imported.kind === 'dynamic-import')) continue
		collectOutputs(
			resolveOutput(outputs, byBasename, imported.path),
			outputs, byBasename, selected, includeDynamic
		)
	}
}

function sourceContributions(selected, outputs) {
	const contributions = new Map()
	for (const output of selected) {
		for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) {
			contributions.set(source, (contributions.get(source) ?? 0) + detail.bytesInOutput)
		}
	}
	return [...contributions.entries()]
		.map(([source, bytes]) => ({source, bytes}))
		.sort((left, right) => right.bytes - left.bytes || left.source.localeCompare(right.source))
}

async function bytesFor(selected, outputs, outputDirectory) {
	let minified = 0
	let brotli = 0
	for (const output of selected) {
		const bytes = await readFile(join(outputDirectory, basename(output)))
		minified += Math.max(bytes.byteLength, outputs[output].bytes)
		brotli += brotliCompressSync(bytes, {
			params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 11}
		}).byteLength
	}
	return {minified, brotli}
}

async function measure(scenario, outputs, byEntry, byBasename, outputDirectory) {
	const initial = new Set()
	const total = new Set()
	for (const entry of scenario.entries) {
		collectOutputs(byEntry.get(entry), outputs, byBasename, initial, false)
		collectOutputs(byEntry.get(entry), outputs, byBasename, total, true)
	}
	const initialBytes = await bytesFor(initial, outputs, outputDirectory)
	const totalBytes = await bytesFor(total, outputs, outputDirectory)
	const contributions = sourceContributions(total, outputs)
	const included = new Set(contributions.map(({source}) => source))
	for (const source of scenario.required ?? []) {
		if (!included.has(source)) throw new Error(`${scenario.name} is undercounting ${source}`)
	}
	for (const source of scenario.excluded ?? []) {
		if (included.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
	}
	return {
		name: scenario.name,
		initialMinified: initialBytes.minified,
		initialBrotli: initialBytes.brotli,
		totalMinified: totalBytes.minified,
		totalBrotli: totalBytes.brotli,
		chunks: total.size,
		minifiedLimit: scenario.minifiedLimit,
		brotliLimit: scenario.brotliLimit,
		contributions
	}
}

async function run() {
	const outputDirectory = await mkdtemp(join(tmpdir(), 'ooops-errors-size-'))
	try {
		await build({
			entry: ENTRY,
			format: ['esm'], platform: 'node', target: 'node22',
			external: ['@ooopsstudio/core', '@ooopsstudio/core/*'],
			splitting: true, treeshake: true, minify: true, dts: false,
			sourcemap: false, clean: true, outDir: outputDirectory,
			metafile: true, config: false, silent: true
		})
		const metafile = JSON.parse(await readFile(join(outputDirectory, 'metafile-esm.json'), 'utf8'))
		const outputs = metafile.outputs
		const byBasename = new Map(Object.keys(outputs).map((output) => [basename(output), output]))
		const byEntry = new Map(Object.entries(outputs)
			.filter(([, detail]) => typeof detail.entryPoint === 'string')
			.map(([output, detail]) => [detail.entryPoint, output]))
		const results = []
		for (const scenario of SCENARIOS) {
			results.push(await measure(scenario, outputs, byEntry, byBasename, outputDirectory))
		}
		if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
		else {
			console.log('Errors scenario size audit (workspace dependencies external)')
			console.log('Scenario | Initial min | Initial br | Total min | Total br | Chunks | Budgets')
			for (const result of results) {
				const pass = result.totalMinified <= result.minifiedLimit
					&& result.totalBrotli <= result.brotliLimit
				console.log(`${result.name} | ${formatBytes(result.initialMinified)} | ${formatBytes(result.initialBrotli)} | ${formatBytes(result.totalMinified)} | ${formatBytes(result.totalBrotli)} | ${result.chunks} | ${formatBytes(result.minifiedLimit)}/${formatBytes(result.brotliLimit)} ${pass ? 'PASS' : 'FAIL'}`)
				if (process.argv.includes('--details')) {
					for (const contribution of result.contributions.slice(0, 12)) {
						console.log(`  ${formatBytes(contribution.bytes)}  ${contribution.source}`)
					}
				}
			}
		}
		const failures = results.filter((result) => result.totalMinified > result.minifiedLimit
			|| result.totalBrotli > result.brotliLimit)
		if (failures.length > 0) throw new Error(`Errors size budgets exceeded: ${failures.map(({name}) => name).join(', ')}`)
	} finally {
		await rm(outputDirectory, {recursive: true, force: true})
	}
}

await run()
