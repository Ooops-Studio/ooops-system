import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/performance/index.ts',
		development: 'src/performance/public/development.ts',
		production: 'src/performance/public/production.ts',
		custom: 'src/performance/public/custom.ts',
		'custom/exporters/raw': 'src/performance/public/custom-exporters-raw.ts',
		'custom/exporters/http': 'src/performance/public/custom-exporters-http.ts',
		observability: 'src/performance/public/observability.ts',
		'public/types': 'src/performance/public/types.ts'
	},
	format: ['esm'],
	platform: 'node',
	target: 'node22',
	dts: {resolve: true},
	sourcemap: true,
	clean: true,
	splitting: true,
	treeshake: true,
	minify: false
})
