import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		development: 'src/public/development.ts',
		production: 'src/public/production.ts',
		'production/prometheus': 'src/public/production-prometheus.ts',
		'production/otlp': 'src/public/production-otlp.ts',
		custom: 'src/public/custom.ts',
		'sinks/index': 'src/sinks/index.ts',
		'sinks/prometheus': 'src/sinks/prometheus.ts',
		'sinks/prometheus-http': 'src/sinks/prometheus-http.ts',
		'sinks/otlp': 'src/sinks/otlp.ts',
		'public/types': 'src/public/types.ts'
	},
	format: ['esm'],
	platform: 'neutral',
	target: 'node22',
	dts: {resolve: true},
	sourcemap: true,
	clean: true,
	splitting: true,
	treeshake: true,
	minify: false
})
