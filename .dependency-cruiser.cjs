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

		// Source files may collaborate freely inside their own package. Keep
		// package boundaries explicit: cross-package source imports bypass export
		// maps and are not allowed.
		{name: 'no-core-to-logging-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/logging/src/'}
		},
		{name: 'no-core-to-errors-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/errors/src/'}
		},
		{name: 'no-core-to-metrics-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/metrics/src/'}
		},
		{name: 'no-core-to-lifecycle-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/lifecycle/src/'}
		},
		{name: 'no-core-to-tracing-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/tracing/src/'}
		},
		{name: 'no-core-to-profiling-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/profiling/src/'}
		},
		{name: 'no-core-to-performance-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/performance/src/'}
		},
		{name: 'no-core-to-audit-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/audit/src/'}
		},
		{name: 'no-core-to-cache-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/cache/src/'}
		},
		{name: 'no-core-to-rate-limit-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/rate-limit/src/'}
		},
		{name: 'no-core-to-resilience-internals', severity: 'error',
			from: {path: '^packages/core/src/'},
			to:   {path: '^packages/resilience/src/'}
		},
		{name: 'no-logging-to-core-internals', severity: 'error',
			from: {path: '^packages/logging/src/'},
			to:   {path: '^packages/core/src/'}
		},
		{name: 'no-logging-to-errors-internals', severity: 'error',
			from: {path: '^packages/logging/src/'},
			to:   {path: '^packages/errors/src/'}
		},
		{name: 'no-logging-to-metrics-internals', severity: 'error',
			from: {path: '^packages/logging/src/'},
			to:   {path: '^packages/metrics/src/'}
		},
		{name: 'no-logging-to-lifecycle-internals', severity: 'error',
			from: {path: '^packages/logging/src/'},
			to:   {path: '^packages/lifecycle/src/'}
		},
		{name: 'no-errors-to-core-internals', severity: 'error',
			from: {path: '^packages/errors/src/'},
			to:   {path: '^packages/core/src/'}
		},
		{name: 'no-errors-to-logging-internals', severity: 'error',
			from: {path: '^packages/errors/src/'},
			to:   {path: '^packages/logging/src/'}
		},
		{name: 'no-errors-to-metrics-internals', severity: 'error',
			from: {path: '^packages/errors/src/'},
			to:   {path: '^packages/metrics/src/'}
		},
		{name: 'no-errors-to-lifecycle-internals', severity: 'error',
			from: {path: '^packages/errors/src/'},
			to:   {path: '^packages/lifecycle/src/'}
		},
		{name: 'metrics-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/metrics/src/'},
			to: {
				path: '^packages/(logging|errors|services)/src/'
			}
		},
		{name: 'no-metrics-to-core-internals', severity: 'error',
			from: {path: '^packages/metrics/src/'},
			to:   {path: '^packages/core/src/'}
		},
		{name: 'no-metrics-to-lifecycle-internals', severity: 'error',
			from: {path: '^packages/metrics/src/'},
			to:   {path: '^packages/lifecycle/src/'}
		},
		{name: 'lifecycle-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/lifecycle/src/'},
			to: {path: '^packages/(logging|errors|metrics|services)/src/'}
		},
		{name: 'no-lifecycle-to-core-internals', severity: 'error',
			from: {path: '^packages/lifecycle/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'tracing-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/tracing/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|services)/src/'}
		},
		{name: 'no-tracing-to-core-internals', severity: 'error',
			from: {path: '^packages/tracing/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'profiling-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/profiling/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|services)/src/'}
		},
		{name: 'no-profiling-to-core-internals', severity: 'error',
			from: {path: '^packages/profiling/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'performance-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/performance/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|services)/src/'}
		},
		{name: 'no-performance-to-core-internals', severity: 'error',
			from: {path: '^packages/performance/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'audit-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/audit/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|services)/src/'}
		},
		{name: 'no-audit-to-core-internals', severity: 'error',
			from: {path: '^packages/audit/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'cache-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/cache/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|services)/src/'}
		},
		{name: 'no-cache-to-core-internals', severity: 'error',
			from: {path: '^packages/cache/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'rate-limit-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/rate-limit/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|cache|services)/src/'}
		},
		{name: 'no-rate-limit-to-core-internals', severity: 'error',
			from: {path: '^packages/rate-limit/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'resilience-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/resilience/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|cache|rate-limit|services)/src/'}
		},
		{name: 'no-resilience-to-core-internals', severity: 'error',
			from: {path: '^packages/resilience/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'events-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/events/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|cache|rate-limit|resilience|services)/src/'}
		},
		{name: 'no-events-to-core-internals', severity: 'error',
			from: {path: '^packages/events/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'jobs-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/jobs/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|cache|rate-limit|resilience|events|services)/src/'}
		},
		{name: 'no-jobs-to-core-internals', severity: 'error',
			from: {path: '^packages/jobs/src/'},
			to: {path: '^packages/core/src/'}
		},
		{name: 'no-domain-to-bridges', severity: 'error',
			from: {path: '^packages/(audit|cache|events|jobs|lifecycle|performance|profiling|rate-limit|resilience)/src/'},
			to: {path: '^packages/bridges/src/'}
		},
		{name: 'sdk-only-depends-on-core-package', severity: 'error',
			from: {path: '^packages/sdk/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|cache|rate-limit|resilience|events|jobs|bridges|sveltekit)/src/'}
		},
		{name: 'sveltekit-only-depends-on-core-and-sdk', severity: 'error',
			from: {path: '^packages/sveltekit/src/'},
			to: {path: '^packages/(logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|cache|rate-limit|resilience|events|jobs|bridges)/src/'}
		},
		{name: 'no-core-or-domain-to-sdk-adapters', severity: 'error',
			from: {path: '^packages/(core|logging|errors|metrics|lifecycle|tracing|profiling|performance|audit|cache|rate-limit|resilience|events|jobs|bridges)/src/'},
			to: {path: '^packages/(sdk|sveltekit)/src/'}
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
