import {readFile, readdir} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {describe, expect, it} from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('built performance export contract', () => {
	it('publishes only the managed presets and custom exporter paths', async() => {
		const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {exports: Record<string, unknown>}
		const paths = Object.keys(manifest.exports)
		expect(paths).toEqual([
			'.', './development', './production', './custom', './custom/exporters/raw',
			'./custom/exporters/http', './observability', './public/types'
		])
		expect(paths.some((key) => /minimal|testing|profil/u.test(key))).toBe(false)
	})

	it('imports every built runtime subpath', async() => {
		const load = async(path: string) => await import(pathToFileURL(join(packageRoot, 'dist', path)).href)
		const [root, development, production, custom, raw, http] = await Promise.all([
			load('index.js'), load('development.js'), load('production.js'), load('custom.js'),
			load('custom/exporters/raw.js'), load('custom/exporters/http.js')
		])
		expect(Object.keys(root)).toEqual(['registerPerformance'])
		expect(development).toHaveProperty('createDevelopmentPerformance')
		expect(production).toHaveProperty('createProductionPerformance')
		expect(custom).toHaveProperty('createCustomPerformance')
		expect(raw).toHaveProperty('definePerformanceEventExporter')
		expect(http).toHaveProperty('createHttpNdjsonPerformanceEventExporter')
	})

	it('does not leak removed contracts through declarations', async() => {
		const files = await readdir(join(packageRoot, 'dist'), {recursive: true})
		const declarations = await Promise.all(files
			.filter((name) => name.endsWith('.d.ts'))
			.map((name) => readFile(join(packageRoot, 'dist', name), 'utf8')))
		const publicText = declarations.join('\n')
		for (const removed of [
			'dispose', 'markStart', 'markEnd', 'startFeatureGuard', 'recordRequest',
			'getSLOStatus', 'getRollup', 'getTopSlowOperations', 'getHottestRoutes',
			'getHeaviestCollections', 'getRecurringOffenders', 'setCallbacks',
			'resetCallbacks', 'PerformanceBridgeCallbacks', 'createTestingPerformance',
			'createMinimalPerformance'
		]) expect(publicText).not.toContain(removed)
	})
})
