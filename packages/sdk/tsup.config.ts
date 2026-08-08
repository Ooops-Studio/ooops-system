// packages/sdk/tsup.config.ts
import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		'cache': 'src/cache.ts',
		'events': 'src/events.ts',
		'events/zod': 'src/events-zod.ts',
		'events/asyncapi': 'src/events-asyncapi.ts',
		'jobs': 'src/jobs.ts',
		'faro-browser': 'src/faro-browser.ts',
		'performance': 'src/performance.ts',
		'performance-browser': 'src/performance-browser.ts',
		'performance-db': 'src/performance-db.ts'
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
