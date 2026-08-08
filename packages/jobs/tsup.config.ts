import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/jobs/index.ts',
		development: 'src/jobs/public/development.ts',
		production: 'src/jobs/public/production.ts',
		custom: 'src/jobs/public/custom.ts',
		admin: 'src/jobs/admin.ts',
		observability: 'src/jobs/public/observability.ts',
		'backends/redis': 'src/jobs/backends-redis.ts',
		'backends/sql': 'src/jobs/backends-sql.ts',
		'custom/backends/memory': 'src/jobs/custom-backend-memory.ts',
		'migrations/redis': 'src/jobs/migrations-redis.ts',
		'migrations/sql': 'src/jobs/migrations-sql.ts'
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
