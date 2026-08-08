import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		development: 'src/public/development.ts',
		production: 'src/public/production.ts',
		custom: 'src/public/custom.ts',
		node: 'src/public/node.ts',
		observability: 'src/public/observability.ts',
		'public/types': 'src/public/types.ts'
	},
	format: ['esm'], platform: 'neutral', target: 'node22', dts: {resolve: true}, sourcemap: true,
	clean: true, splitting: true, treeshake: true, minify: false
})
