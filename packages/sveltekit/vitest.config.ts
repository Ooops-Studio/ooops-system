import {resolve} from 'node:path'

import {defineConfig, mergeConfig} from 'vitest/config'

import base from '../../vitest.config'

export default mergeConfig(base, defineConfig({
	resolve: {
		alias: [
			{find: /^@ooopsstudio\/sdk\/(.*)$/, replacement: resolve(__dirname, '../sdk/src/$1')},
			{find: /^@ooopsstudio\/core\/(.*)$/, replacement: resolve(__dirname, '../core/src/$1')},
			{find: '@ooopsstudio/core', replacement: resolve(__dirname, '../core/src/index.ts')}
		]
	},
	test: {
		passWithNoTests: true,
		coverage: {
			exclude: [
				'**/*.d.ts',
				'**/*.{test,spec}.{ts,tsx}',
				'**/__tests__/**'
			],

			thresholds: {
				perFile: true,
				statements: 90,
				branches: 90,
				functions: 90,
				lines: 90
			}
		}
	}
}))
