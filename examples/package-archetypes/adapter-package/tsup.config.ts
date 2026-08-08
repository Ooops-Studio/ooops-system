import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts'
	},
	format: ['esm'],
	platform: 'neutral',
	target: 'es2022',
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	minify: false
})
