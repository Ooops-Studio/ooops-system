import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = Object.freeze({
	root: 'src/index.ts',
	development: 'src/public/development.ts',
	production: 'src/public/production.ts',
	custom: 'src/public/custom.ts',
	direct: 'src/core/simple-processor.ts',
	directResilient: 'src/core/custom-direct-delivery.ts',
	batched: 'src/core/custom-batched-delivery.ts',
	sinks: 'src/sinks/index.ts',
	helpers: 'src/public/helpers.ts',
	observability: 'src/public/observability.ts'
})
const SOURCE = Object.freeze({
	otlp: 'src/features/exporters/http-otlp-exporter.ts',
	sinks: 'src/sinks/index.ts',
	transport: 'src/sinks/public-https.ts',
	batching: 'src/core/batching-processor.ts',
	resilience: 'src/core/transferring.ts',
	console: 'src/features/exporters/console-exporter.ts',
	runtime: 'src/core/tracer.ts'
})
const SCENARIOS = Object.freeze([
	{name: 'root registration initial load', entries: [ENTRY.root], followDynamic: false, limit: 14_000, brotliLimit: 5_000,
		excluded: [SOURCE.runtime, SOURCE.otlp, SOURCE.console, SOURCE.batching, SOURCE.resilience]},
	{name: 'development console', entries: [ENTRY.development], followDynamic: true, limit: 72_200, brotliLimit: 22_000,
		required: [SOURCE.console, SOURCE.runtime], excluded: [SOURCE.otlp, SOURCE.batching, SOURCE.resilience]},
	{name: 'production OTLP', entries: [ENTRY.production], followDynamic: true, limit: 97_500, brotliLimit: 30_100,
		required: [SOURCE.otlp, SOURCE.transport, SOURCE.batching, SOURCE.resilience]},
	{name: 'custom exporter direct', entries: [ENTRY.custom, ENTRY.direct], followDynamic: false, limit: 75_000, brotliLimit: 22_600,
		required: [SOURCE.runtime, 'src/core/simple-processor.ts'], excluded: [SOURCE.otlp, SOURCE.sinks, SOURCE.batching, SOURCE.resilience]},
	{name: 'custom exporter direct retry', entries: [ENTRY.custom, ENTRY.directResilient], followDynamic: false, limit: 83_700, brotliLimit: 25_500,
		required: [SOURCE.runtime, SOURCE.resilience, 'src/core/simple-processor.ts'], excluded: [SOURCE.otlp, SOURCE.sinks, SOURCE.batching]},
	{name: 'custom exporter batched', entries: [ENTRY.custom, ENTRY.batched], followDynamic: false, limit: 85_600, brotliLimit: 26_100,
		required: [SOURCE.runtime, SOURCE.batching, SOURCE.resilience], excluded: [SOURCE.otlp, SOURCE.sinks, 'src/core/simple-processor.ts']},
	{name: 'custom OTLP', entries: [ENTRY.custom, ENTRY.batched, ENTRY.sinks], followDynamic: true, limit: 106_200, brotliLimit: 32_800,
		required: [SOURCE.otlp, SOURCE.sinks, SOURCE.transport, SOURCE.batching, SOURCE.resilience]},
	{name: 'helpers only', entries: [ENTRY.helpers], followDynamic: true, limit: 10_000, brotliLimit: 4_000,
		excluded: [SOURCE.runtime, SOURCE.otlp, SOURCE.console, SOURCE.batching, SOURCE.resilience]},
	{name: 'observability only', entries: [ENTRY.observability], followDynamic: true, limit: 9_000, brotliLimit: 3_000,
		excluded: [SOURCE.runtime, SOURCE.otlp, SOURCE.console, SOURCE.batching, SOURCE.resilience]}
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
	for (const output of selected) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) {
		values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput)
	}
	return [...values].map(([source, bytes]) => ({source, bytes}))
		.sort((left, right) => right.bytes - left.bytes || left.source.localeCompare(right.source))
}

async function measure(scenario, outputs, byEntry, byBase, directory) {
	const initial = new Set()
	for (const entry of scenario.entries) collect(byEntry.get(entry), outputs, byBase, initial, false)
	const total = new Set()
	for (const entry of scenario.entries) collect(byEntry.get(entry), outputs, byBase, total, scenario.followDynamic)
	const byteTotals = async(selected) => {
		let minified = 0; let brotli = 0
		for (const output of selected) {
			const bytes = await readFile(join(directory, basename(output)))
			minified += Math.max(bytes.byteLength, outputs[output].bytes)
			brotli += brotliCompressSync(bytes, {params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 11}}).byteLength
		}
		return {minified, brotli}
	}
	const sourceContributions = contributions(total, outputs)
	const included = new Set(sourceContributions.map(({source}) => source))
	for (const source of scenario.required ?? []) if (!included.has(source)) throw new Error(`${scenario.name} is undercounting ${source}`)
	for (const source of scenario.excluded ?? []) if (included.has(source)) throw new Error(`${scenario.name} unexpectedly includes ${source}`)
	return {name: scenario.name, initial: await byteTotals(initial), total: await byteTotals(total), chunks: total.size,
		limit: scenario.limit, brotliLimit: scenario.brotliLimit, contributions: sourceContributions}
}

const directory = await mkdtemp(join(tmpdir(), 'ooops-tracing-size-'))
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
	for (const scenario of SCENARIOS) results.push(await measure(scenario, outputs, byEntry, byBase, directory))
	if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
	else {
		console.log('Tracing scenario size audit (workspace dependencies external)')
		console.log('Scenario | Initial min/Brotli | Total min/Brotli | Chunks | Budget')
		for (const result of results) {
			const state = result.total.minified <= result.limit && result.total.brotli <= result.brotliLimit ? 'PASS' : 'FAIL'
			console.log(`${result.name} | ${formatBytes(result.initial.minified)}/${formatBytes(result.initial.brotli)} | ${formatBytes(result.total.minified)}/${formatBytes(result.total.brotli)} | ${result.chunks} | ${formatBytes(result.limit)}/${formatBytes(result.brotliLimit)} ${state}`)
			if (process.argv.includes('--details')) for (const item of result.contributions.slice(0, 12)) console.log(`  ${formatBytes(item.bytes)}  ${item.source}`)
		}
	}
	const failures = results.filter((result) => result.total.minified > result.limit || result.total.brotli > result.brotliLimit)
	if (failures.length) throw new Error(`Tracing size budgets exceeded: ${failures.map(({name}) => name).join(', ')}`)
} finally {
	await rm(directory, {recursive: true, force: true})
}
