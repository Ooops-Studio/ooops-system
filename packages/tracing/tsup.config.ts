import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		development: 'src/public/development.ts',
		production: 'src/public/production.ts',
		custom: 'src/public/custom.ts',
		helpers: 'src/public/helpers.ts',
		observability: 'src/public/observability.ts'
	},
	format: ['esm'], platform: 'node', target: 'node22', dts: {resolve: true}, sourcemap: true,
	clean: true, splitting: true, treeshake: true, minify: false
})
