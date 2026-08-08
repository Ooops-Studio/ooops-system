import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/resilience/index.ts',
		development: 'src/resilience/public/development.ts',
		production: 'src/resilience/public/production.ts',
		custom: 'src/resilience/public/custom.ts',
		observability: 'src/resilience/public/observability.ts',
		'public/types': 'src/resilience/public/types.ts'
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
