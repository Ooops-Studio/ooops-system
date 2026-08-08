import {defineConfig, mergeConfig} from 'vitest/config'

import base from '../../vitest.config'

export default mergeConfig(base, defineConfig({
	test: {
		passWithNoTests: true,
		coverage: {
			include: ['src/**/*.{ts,tsx}'],
			exclude: [
				'**/*.d.ts',
				'**/*.{test,spec}.{ts,tsx}',
				'**/__tests__/**',
				'src/**/index.ts',
				'src/ports/**',
				'src/contracts/{audit,cache,clock,context,errors,events,jobs,json,logging,observability,observability-shared,performance,profiling,rate-limit,sink,tracing}.ts',
				'src/utils/testing/**'
			],

			thresholds: {
				perFile: false,
				statements: 80,
				branches: 80,
				functions: 90,
				lines: 80
			}
		}
	}
}))
