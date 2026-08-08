import {readFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {describe, expect, it} from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('built tracing export contract', () => {
	it('publishes only the documented root, preset, and helpers subpaths', async() => {
		const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {exports: Record<string, unknown>}
		const tracingPaths = Object.keys(manifest.exports)
		expect(tracingPaths).toEqual([
			'.', './development', './production', './custom', './helpers', './observability'
		])
		expect(tracingPaths.some((key) => /minimal|testing|processor|public/u.test(key))).toBe(false)
	})

	it('imports every built subpath and keeps providers out of the root runtime surface', async() => {
		const load = async(path: string) => await import(pathToFileURL(join(packageRoot, 'dist', path)).href)
		const [root, development, production, custom, helpers, observability] = await Promise.all([
			load('index.js'), load('development.js'), load('production.js'), load('custom.js'), load('helpers.js'),
			load('observability.js')
		])
		expect(Object.keys(root)).toEqual(['registerTracing'])
		expect(development).toHaveProperty('createDevelopmentTracing')
		expect(production).toHaveProperty('createProductionTracing')
		expect(custom).toHaveProperty('createCustomTracing')
		expect(helpers).toMatchObject({
			traceDb: expect.any(Function), traceHttpClient: expect.any(Function), traceJob: expect.any(Function)
		})
		expect(observability).toMatchObject({
			getActiveSpanContext: expect.any(Function), getTraceCorrelation: expect.any(Function)
		})
	}, 120_000)

	it('does not leak removed contracts through declaration output', async() => {
		const declarations = await Promise.all([
			'index.d.ts', 'development.d.ts', 'production.d.ts', 'custom.d.ts', 'helpers.d.ts', 'observability.d.ts'
		].map((name) => readFile(join(packageRoot, 'dist', name), 'utf8')))
		const publicText = declarations.join('\n')
		for (const removed of [
			'SpanProcessorPort', 'PropagationConfig', 'PropagationFormat', 'WithExtractedHeadersOptions',
			'createTestingTracing', 'createMinimalTracing', 'TracingSnapshot', 'RecentSpans'
		]) expect(publicText).not.toContain(removed)
	})
})
