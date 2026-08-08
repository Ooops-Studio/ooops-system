/* eslint-disable @stylistic/max-len -- scenario tables stay readable as one row per path */
import {runScenarioSizeAudit} from '../../scripts/scenario-size-audit.mjs'

const entries = Object.freeze({
	root: 'src/index.ts', development: 'src/public/development.ts', production: 'src/public/production.ts',
	custom: 'src/public/custom.ts', node: 'src/public/node.ts', observability: 'src/public/observability.ts'
})
const source = Object.freeze({
	runtime: 'src/core/lifecycle-handler.ts', health: 'src/core/health-manager.ts',
	telemetry: 'src/core/telemetry-controller.ts', node: entries.node, observability: entries.observability
})
const presets = [entries.development, entries.production, entries.custom]
const budget = (initialMinified, initialBrotli, totalMinified, totalBrotli) =>
	Object.freeze({initialMinified, initialBrotli, totalMinified, totalBrotli})

await runScenarioSizeAudit({
	label: 'Lifecycle', slug: 'lifecycle', entries,
	scenarios: [
		{name: 'root registration initial load', initial: ['root'], initialRequired: [entries.root],
			initialExcluded: [...presets, source.runtime, source.health, source.node], budgets: budget(9_000, 3_000, 9_000, 3_000)},
		{name: 'development core', initial: ['development'], required: [source.runtime, source.health, source.telemetry],
			excluded: [source.node], budgets: budget(30_000, 9_000, 30_000, 9_000)},
		{name: 'production core', initial: ['production'], required: [source.runtime, source.health, source.telemetry],
			excluded: [source.node], budgets: budget(30_000, 9_000, 30_000, 9_000)},
		{name: 'custom core', initial: ['custom'], required: [source.runtime, source.health, source.telemetry],
			excluded: [source.node], budgets: budget(30_000, 9_000, 30_000, 9_000)},
		{name: 'Node adapter', initial: ['node'], required: [source.node],
			excluded: [source.runtime, source.health, source.telemetry], budgets: budget(8_000, 3_000, 8_000, 3_000)},
		{name: 'observability attachment', initial: ['observability'], required: [source.observability, source.telemetry],
			excluded: [source.runtime, source.health, source.node], budgets: budget(7_000, 3_000, 7_000, 3_000)},
		{name: 'production + Node adapter', initial: ['production'], selected: ['node'],
			required: [source.runtime, source.health, source.telemetry, source.node], budgets: budget(30_000, 9_000, 34_000, 11_000)},
		{name: 'production + observability', initial: ['production'], selected: ['observability'],
			required: [source.runtime, source.health, source.telemetry, source.observability], excluded: [source.node], budgets: budget(30_000, 9_000, 31_000, 10_000)}
	]
})
