import {resolve} from 'node:path'

import {defineConfig, mergeConfig} from 'vitest/config'

import base from '../../vitest.config'

export default mergeConfig(base, defineConfig({
	resolve: {
		alias: [
			{
				find: /^@ooopsstudio\/core\/(.+)$/,
				replacement: resolve(import.meta.dirname, '../core/src/$1')
			},
			{
				find: '@ooopsstudio/core',
				replacement: resolve(import.meta.dirname, '../core/src/index.ts')
			}
		]
	},
	test: {
		passWithNoTests: false,
		coverage: {
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.d.ts', 'src/types/**/*.ts', 'src/public/types.ts', 'src/sinks/types.ts']
		}
	}
}))
