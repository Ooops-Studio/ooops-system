/**
 * @file Dependency cruiser configuration
 * Enforces acyclic dependency graph and import hygiene in the monorepo.
 *
 * Guidance:
 * - No circular dependencies
 * - Do not import other packages’ internals (use published exports only)
 * - Production code must not depend on devDependencies
 * - Keep tests and test helpers out of runtime code
 */

const path = require('node:path')
const repoRoot = __dirname
module.exports = {
	forbidden: [
		{name: 'no-cycles',     severity: 'error', from: {}, to: {circular: true}},
		{name: 'no-unresolved', severity: 'error', from: {}, to: {couldNotResolve: true}},

		// Don’t pull test helpers into runtime
		{name: 'no-test-helpers-in-src', severity: 'error',
			from: {path: '^packages/.*/src/'},
			to:   {path: '^packages/.*/(test|__tests__|testing)/'}
		},

		// Don’t import another package’s internals (only published exports)
		{name: 'no-cross-internals', severity: 'error',
			from: {path: '^packages/.*/src/'},
			to:   {path: '^packages/.*/src/'}
		},

		// Production code must not depend on devDeps
		{name: 'no-dev-deps-in-src', severity: 'error',
			from: {path: '^packages/.*/src/'},
			to:   {dependencyTypes: ['npm-dev']}
		}
	],
	options: {
		tsPreCompilationDeps: true,
		includeOnly: '^(packages)/',
		tsConfig: {fileName: path.join(repoRoot, 'tsconfig.base.json')},
		enhancedResolveOptions: {
			extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
		},
		doNotFollow: {path: 'node_modules'},
		exclude: {
			path: [
				'node_modules',
				'dist',
				'coverage',
				'.husky',
				'test',
				'(^|/)\\.' // only dot-directories, not file extensions
			]
		}
	}
}