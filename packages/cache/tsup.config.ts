import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/cache/index.ts',
		development: 'src/cache/public/development.ts',
		production: 'src/cache/public/production.ts',
		custom: 'src/cache/public/custom.ts',
		observability: 'src/cache/public/observability.ts',
		'public/types': 'src/cache/public/types.ts'
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
