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
		passWithNoTests: true,
		coverage: {
			include: ['src/**/*.ts'],
			exclude: [
				'src/types/**/*.ts',
				'src/public/types.ts',
				'src/sinks/types.ts',
				'src/features/transferring/batching-types.ts'
			]
		}
	}
}))
