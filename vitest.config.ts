import {defineConfig, configDefaults} from 'vitest/config'
const ci = !!process.env.CI

export default defineConfig({
	test: {
		environment: 'node',

		// Be explicit so Vitest doesn’t wander into examples or scripts
		include: ['**/*.{test,spec}.{ts,tsx}'],
		exclude: [
			...configDefaults.exclude,         // node_modules, .git, etc
			'dist/**',
			'coverage/**'
		],

		// CI-friendly output; locally keep it simple
		reporters: ci ? ['default', 'junit'] : ['default'],
		...(ci ? {outputFile: {junit: './junit-report.xml'}} : {}),

		passWithNoTests: true,

		coverage: {
			provider: 'v8',
			reportsDirectory: './coverage',
			reporter: ['text', 'json', 'html', ...(process.env.CI ? ['lcov'] : [])],

			// Only cover library sources
			include: ['packages/*/src/**/*.{ts,tsx}'],
			// Do not count type decls, test files, or published test helpers
			exclude: [
				'**/*.d.ts',
				'**/*.{test,spec}.{ts,tsx}',
				'**/__tests__/**'
			],
			// Make cheating harder: every file must meet the bar
			thresholds: {
				perFile: true,
				statements: 90,
				branches: 90,
				functions: 90,
				lines: 90
			}
		}
	}
})