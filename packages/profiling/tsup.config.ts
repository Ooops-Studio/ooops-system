import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		development: 'src/public/development.ts',
		production: 'src/public/production.ts',
		custom: 'src/public/custom.ts',
		'profilers/inspector': 'src/profilers-inspector.ts',
		'providers/pyroscope': 'src/providers-pyroscope.ts',
		'exporters/console': 'src/exporters-console.ts',
		'exporters/memory': 'src/exporters-memory.ts',
		observability: 'src/public/observability.ts'
	},
	format: ['esm'],
	platform: 'node',
	target: 'node22',
	dts: {resolve: true},
	sourcemap: true,
	clean: true,
	splitting: true,
	treeshake: true,
	minify: false,
	external: ['@pyroscope/nodejs']
})
