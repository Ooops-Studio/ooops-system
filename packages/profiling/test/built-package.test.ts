import {access, readFile} from 'node:fs/promises'

import {describe, expect, it} from 'vitest'

describe('built profiling package', () => {
	it('imports root, presets, low-level profiler, provider and exporters independently', async() => {
		const paths = [
			'../dist/index.js', '../dist/development.js',
			'../dist/production.js', '../dist/custom.js',
			'../dist/profilers/inspector.js', '../dist/providers/pyroscope.js',
			'../dist/exporters/console.js', '../dist/exporters/memory.js',
			'../dist/observability.js'
		]
		for (const path of paths) await access(new URL(path, import.meta.url))
		const [root, inspector, provider, observability] = await Promise.all([
			import('../dist/index.js'), import('../dist/profilers/inspector.js'), import('../dist/providers/pyroscope.js'),
			import('../dist/observability.js')
		])
		expect(root.registerProfiling).toBeTypeOf('function')
		expect(inspector.createInspectorProfiler).toBeTypeOf('function')
		expect(provider.createPyroscopeProfiling).toBeTypeOf('function')
		expect(Object.keys(observability)).toEqual(['attachProfilingObservability'])
		const declaration = await readFile(new URL('../dist/observability.d.ts', import.meta.url), 'utf8')
		expect(declaration).toContain('attachProfilingObservability')
		expect(declaration).toMatch(/ProfilingObservabilityEvent|ProfilingObservabilityListener/u)
	})
})
