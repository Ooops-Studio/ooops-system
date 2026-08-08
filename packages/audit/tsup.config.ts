import {defineConfig} from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/audit/index.ts',
		development: 'src/audit/public/development.ts',
		production: 'src/audit/public/production.ts',
		custom: 'src/audit/public/custom.ts',
		admin: 'src/audit/admin.ts',
		observability: 'src/audit/public/observability.ts',
		'public/types': 'src/audit/public/types.ts'
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
