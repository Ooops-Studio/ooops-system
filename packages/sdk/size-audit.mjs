import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {brotliCompressSync, constants} from 'node:zlib'

import {build} from 'tsup'

const ENTRY = {
	cache: 'src/cache.ts', jobs: 'src/jobs.ts', events: 'src/events.ts', eventsZod: 'src/events-zod.ts', asyncapi: 'src/events-asyncapi.ts',
	performance: 'src/performance.ts', browser: 'src/performance-browser.ts', db: 'src/performance-db.ts', faro: 'src/faro-browser.ts'
}
const scenarios = [
	['cache', ENTRY.cache, 9_000, 3_000], ['jobs', ENTRY.jobs, 6_000, 2_600],
	['event definitions', ENTRY.events, 8_000, 3_000], ['Zod event adapter', ENTRY.eventsZod, 314_000, 53_000],
	['AsyncAPI', ENTRY.asyncapi, 15_000, 5_000],
	['performance core', ENTRY.performance, 5_000, 2_000], ['performance browser', ENTRY.browser, 17_000, 6_000],
	['DB adapters', ENTRY.db, 6_000, 3_000], ['Faro', ENTRY.faro, 112_000, 37_000]
]
const forbidden = {
	[ENTRY.cache]: ['node_modules/zod/', 'node_modules/@grafana/', 'node_modules/web-vitals/'],
	[ENTRY.jobs]: ['node_modules/zod/', 'node_modules/@grafana/', 'node_modules/web-vitals/'],
	[ENTRY.events]: ['node_modules/zod/', 'node_modules/@grafana/', 'node_modules/web-vitals/'],
	[ENTRY.eventsZod]: ['node_modules/@grafana/', 'node_modules/web-vitals/'],
	[ENTRY.asyncapi]: ['node_modules/zod/', 'node_modules/@grafana/', 'node_modules/web-vitals/'],
	[ENTRY.performance]: ['node_modules/zod/', 'node_modules/@grafana/', 'node_modules/web-vitals/'],
	[ENTRY.db]: ['node_modules/zod/', 'node_modules/@grafana/', 'node_modules/web-vitals/'],
	[ENTRY.browser]: ['node_modules/zod/', 'node_modules/@grafana/']
}
const resolveOutput = (outputs, byBase, value) => outputs[value] ? value : byBase.get(basename(value))
const collect = (root, outputs, byBase, target, dynamic) => {if (!root || target.has(root)) return;target.add(root);for (const item of outputs[root]?.imports ?? []) if (!item.external && (dynamic || item.kind !== 'dynamic-import')) collect(resolveOutput(outputs, byBase, item.path), outputs, byBase, target, dynamic)}
const contribution = (set, outputs) => {const values = new Map();for (const output of set) for (const [source, detail] of Object.entries(outputs[output]?.inputs ?? {})) values.set(source, (values.get(source) ?? 0) + detail.bytesInOutput);return [...values].sort((a, b) => b[1] - a[1])}
const bytes = async(set, outputs, dir) => {let min = 0, br = 0;for (const output of set){const value = await readFile(join(dir, basename(output)));min += Math.max(value.byteLength, outputs[output].bytes);br += brotliCompressSync(value, {params:{[constants.BROTLI_PARAM_QUALITY]:11}}).byteLength} return {min, br}}
const dir = await mkdtemp(join(tmpdir(), 'ooops-sdk-size-'))
try {
	await build({entry:ENTRY, format:['esm'], platform:'neutral', target:'node22', external:['@ooopsstudio/core', '@ooopsstudio/core/*'], noExternal:['zod', 'web-vitals', '@grafana/faro-web-sdk'], splitting:true, treeshake:true, minify:true, dts:false, sourcemap:false, clean:true, outDir:dir, metafile:true, config:false, silent:true})
	const outputs = JSON.parse(await readFile(join(dir, 'metafile-esm.json'), 'utf8')).outputs
	const byBase = new Map(Object.keys(outputs).map((value) => [basename(value), value]));const byEntry = new Map(Object.entries(outputs).filter(([,v]) => v.entryPoint).map(([o, v]) => [v.entryPoint, o]));const results = []
	for (const [name, entry, minLimit, brLimit] of scenarios){const initial = new Set(), total = new Set();collect(byEntry.get(entry), outputs, byBase, initial, false);collect(byEntry.get(entry), outputs, byBase, total, true);const sources = contribution(total, outputs);if (!sources.some(([source]) => source === entry)) throw new Error(`${name} undercounts ${entry}`);for (const pattern of forbidden[entry] ?? []) if (sources.some(([source]) => source.includes(pattern))) throw new Error(`${name} unexpectedly includes ${pattern}`);results.push({name, entry, minLimit, brLimit, initial:await bytes(initial, outputs, dir), total:await bytes(total, outputs, dir), chunks:total.size, sources})}
	console.log('SDK scenario size audit');for (const value of results){const pass = value.total.min <= value.minLimit && value.total.br <= value.brLimit;console.log(`${value.name} | ${(value.initial.min / 1000).toFixed(2)}/${(value.initial.br / 1000).toFixed(2)} kB initial | ${(value.total.min / 1000).toFixed(2)}/${(value.total.br / 1000).toFixed(2)} kB total | ${value.chunks} | ${pass ? 'PASS' : 'FAIL'}`);if (process.argv.includes('--details')) for (const [source, size] of value.sources.slice(0, 12))console.log(`  ${(size / 1000).toFixed(2)} kB ${source}`)}
	const failed = results.filter((v) => v.total.min > v.minLimit || v.total.br > v.brLimit);if (failed.length) throw new Error(`SDK size budgets exceeded: ${failed.map((v) => v.name).join(', ')}`)
} finally {await rm(dir, {recursive:true, force:true})}
