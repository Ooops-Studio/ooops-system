/* eslint-disable @stylistic/max-len -- tabular audit output is intentionally kept together */
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants as zlibConstants} from 'node:zlib'

import {build} from 'tsup'

const formatBytes = (bytes) => `${(bytes / 1_000).toFixed(2)} kB`
const resolveOutput = (outputs, byBasename, path) => outputs[path]
	? path
	: byBasename.get(basename(path))

function collectStatic(root, outputs, byBasename, selected) {
	if (!root || selected.has(root)) return
	selected.add(root)
	for (const imported of outputs[root]?.imports ?? []) {
		if (imported.external || imported.kind === 'dynamic-import') continue
		collectStatic(resolveOutput(outputs, byBasename, imported.path), outputs, byBasename, selected)
	}
}

function contributionsFor(selected, outputs) {
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

async function bytesFor(selected, outputs, directory) {
	let minified = 0
	let brotli = 0
	for (const output of selected) {
		const emitted = await readFile(join(directory, basename(output)))
		minified += Math.max(emitted.byteLength, outputs[output].bytes)
		brotli += brotliCompressSync(emitted, {
			params: {[zlibConstants.BROTLI_PARAM_QUALITY]: 11}
		}).byteLength
	}
	return {minified, brotli}
}

function assertSources(label, included, required = [], excluded = []) {
	for (const source of required) {
		if (!included.has(source)) throw new Error(`${label} is undercounting required source ${source}`)
	}
	for (const source of excluded) {
		if (included.has(source)) throw new Error(`${label} unexpectedly includes ${source}`)
	}
}

export async function runScenarioSizeAudit(config) {
	const directory = await mkdtemp(join(tmpdir(), `ooops-${config.slug}-size-`))
	try {
		await build({
			entry: config.entries,
			format: ['esm'],
			platform: 'node',
			target: 'node22',
			external: ['@ooopsstudio/core', '@ooopsstudio/core/*'],
			splitting: true,
			treeshake: true,
			minify: true,
			dts: false,
			sourcemap: false,
			clean: true,
			outDir: directory,
			metafile: true,
			config: false,
			silent: true
		})
		const metafile = JSON.parse(await readFile(join(directory, 'metafile-esm.json'), 'utf8'))
		const outputs = metafile.outputs
		const byBasename = new Map(Object.keys(outputs).map((output) => [basename(output), output]))
		const byEntry = new Map(Object.entries(outputs)
			.filter(([, detail]) => typeof detail.entryPoint === 'string')
			.map(([output, detail]) => [detail.entryPoint, output]))
		const results = []
		for (const scenario of config.scenarios) {
			const initial = new Set()
			for (const entry of scenario.initial) {
				const output = byEntry.get(config.entries[entry])
				if (!output) throw new Error(`${scenario.name} is missing entry ${entry}`)
				collectStatic(output, outputs, byBasename, initial)
			}
			const total = new Set(initial)
			for (const entry of scenario.selected ?? []) {
				const output = byEntry.get(config.entries[entry])
				if (!output) throw new Error(`${scenario.name} is missing selected entry ${entry}`)
				collectStatic(output, outputs, byBasename, total)
			}
			const initialContributions = contributionsFor(initial, outputs)
			const totalContributions = contributionsFor(total, outputs)
			assertSources(
				`${scenario.name} initial load`,
				new Set(initialContributions.map(({source}) => source)),
				scenario.initialRequired,
				scenario.initialExcluded
			)
			assertSources(
				scenario.name,
				new Set(totalContributions.map(({source}) => source)),
				scenario.required,
				scenario.excluded
			)
			const initialBytes = await bytesFor(initial, outputs, directory)
			const totalBytes = await bytesFor(total, outputs, directory)
			results.push({
				name: scenario.name,
				initialMinified: initialBytes.minified,
				initialBrotli: initialBytes.brotli,
				totalMinified: totalBytes.minified,
				totalBrotli: totalBytes.brotli,
				chunks: total.size,
				budgets: scenario.budgets,
				contributions: totalContributions
			})
		}
		if (process.argv.includes('--json')) console.log(JSON.stringify({results}, null, 2))
		else {
			console.log(`${config.label} scenario size audit (workspace dependencies external)`)
			console.log('Scenario | Initial min/br | Total min/br | Chunks | Budgets')
			for (const result of results) {
				const {budgets} = result
				const pass = result.initialMinified <= budgets.initialMinified
					&& result.initialBrotli <= budgets.initialBrotli
					&& result.totalMinified <= budgets.totalMinified
					&& result.totalBrotli <= budgets.totalBrotli
				console.log(`${result.name} | ${formatBytes(result.initialMinified)}/${formatBytes(result.initialBrotli)} | ${formatBytes(result.totalMinified)}/${formatBytes(result.totalBrotli)} | ${result.chunks} | ${formatBytes(budgets.initialMinified)}/${formatBytes(budgets.initialBrotli)} → ${formatBytes(budgets.totalMinified)}/${formatBytes(budgets.totalBrotli)} ${pass ? 'PASS' : 'FAIL'}`)
				if (process.argv.includes('--details')) {
					for (const contribution of result.contributions.slice(0, 12)) {
						console.log(`  ${formatBytes(contribution.bytes)}  ${contribution.source}`)
					}
				}
			}
		}
		const failures = results.filter(({initialMinified, initialBrotli, totalMinified, totalBrotli, budgets}) =>
			initialMinified > budgets.initialMinified || initialBrotli > budgets.initialBrotli
			|| totalMinified > budgets.totalMinified || totalBrotli > budgets.totalBrotli)
		if (failures.length > 0) {
			throw new Error(`${config.label} size budgets exceeded: ${failures.map(({name}) => name).join(', ')}`)
		}
	} finally {
		await rm(directory, {recursive: true, force: true})
	}
}
