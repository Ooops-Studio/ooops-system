// packages/sveltekit/tsup.config.ts
import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		server: 'src/server.ts',
		actions: 'src/actions.ts'
	},
	format: ['esm'],
	platform: 'neutral',
	target: 'node22',
	dts: {resolve: true},
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	minify: false
})
