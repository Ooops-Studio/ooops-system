import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/events/index.ts',
		development: 'src/events/public/development.ts',
		production: 'src/events/public/production.ts',
		custom: 'src/events/public/custom.ts',
		admin: 'src/events/admin.ts',
		observability: 'src/events/public/observability.ts',
		'backends/custom': 'src/events/backends/custom.ts',
		'stores/memory': 'src/events/stores/memory.ts',
		'stores/postgres': 'src/events/stores/postgres.ts',
		'migrations/postgres': 'src/events/migrations/postgres.ts',
		'transports/custom': 'src/events/transports/custom.ts',
		'transports/http': 'src/events/transports/http.ts',
		'transports/kafka': 'src/events/transports/kafka.ts',
		'transports/nats': 'src/events/transports/nats.ts'
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
