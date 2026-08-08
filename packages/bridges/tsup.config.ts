import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts', observability: 'src/observability.ts', audit: 'src/audit.ts',
		cache: 'src/cache.ts', events: 'src/events.ts', jobs: 'src/jobs.ts',
		lifecycle: 'src/lifecycle.ts', performance: 'src/performance.ts',
		profiling: 'src/profiling.ts', 'rate-limit': 'src/rate-limit.ts', resilience: 'src/resilience.ts'
	},
	format: ['esm'], platform: 'node', target: 'node22', dts: {resolve: true},
	sourcemap: true, clean: true, splitting: true, treeshake: true, minify: false
})
