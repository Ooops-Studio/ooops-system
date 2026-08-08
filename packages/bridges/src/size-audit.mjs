import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync} from 'node:zlib'

import {build} from 'tsup'

const entries = Object.freeze({
	root: 'src/index.ts', observability: 'src/observability.ts', audit: 'src/audit.ts', cache: 'src/cache.ts',
	events: 'src/events.ts', jobs: 'src/jobs.ts', lifecycle: 'src/lifecycle.ts', performance: 'src/performance.ts',
	profiling: 'src/profiling.ts', 'rate-limit': 'src/rate-limit.ts', resilience: 'src/resilience.ts'
})
const limits = Object.freeze({
	root: 2_000, observability: 15_000, audit: 8_000, cache: 8_000, events: 8_000,
	jobs: 8_000, lifecycle: 3_000, performance: 12_000, profiling: 8_000,
	'rate-limit': 7_000, resilience: 7_000
})
const directory = await mkdtemp(join(tmpdir(), 'ooops-bridges-size-'))
try {
	await build({entry: entries, format: ['esm'], platform: 'node', target: 'node22',
		external: [/^@ooopsstudio\//u], splitting: true, treeshake: true, minify: true, dts: false,
		sourcemap: false, clean: true, outDir: directory, metafile: true, config: false, silent: true})
	const outputs = JSON.parse(await readFile(join(directory, 'metafile-esm.json'), 'utf8')).outputs ?? {}
	const rows = []
	for (const [name, entry] of Object.entries(entries)) {
		const output = Object.entries(outputs).find(([, value]) => value.entryPoint === entry)?.[0]
		if (!output) throw new Error(`Missing size output for ${name}`)
		const bytes = await readFile(join(directory, basename(output)))
		rows.push({
			name, minified: bytes.byteLength,
			brotli: brotliCompressSync(bytes).byteLength, limit: limits[name]
		})
	}
	console.log('Bridges entrypoint size audit (workspace dependencies external)')
	for (const row of rows) {
		const result = row.minified <= row.limit ? 'PASS' : 'FAIL'
		console.log(`${row.name}: ${(row.minified / 1_000).toFixed(2)} kB / ${(row.brotli / 1_000).toFixed(2)} kB Brotli ${result}`)
	}
	const failed = rows.filter((row) => row.minified > row.limit)
	if (failed.length) throw new Error(`Bridge size budgets exceeded: ${failed.map(({name}) => name).join(', ')}`)
} finally { await rm(directory, {recursive: true, force: true}) }
