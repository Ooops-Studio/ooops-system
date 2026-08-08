import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/rate-limit/index.ts',
		development: 'src/rate-limit/public/development.ts',
		production: 'src/rate-limit/public/production.ts',
		custom: 'src/rate-limit/public/custom.ts',
		http: 'src/rate-limit/http.ts',
		observability: 'src/rate-limit/public/observability.ts',
		'public/types': 'src/rate-limit/public/types.ts'
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
