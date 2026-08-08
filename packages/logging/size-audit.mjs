/* eslint-disable @stylistic/max-len -- scenario tables stay readable as one row per path */
import {runScenarioSizeAudit} from '../../scripts/scenario-size-audit.mjs'

const entries = Object.freeze({
	root: 'src/index.ts', development: 'src/public/development.ts', production: 'src/public/production.ts',
	custom: 'src/public/custom.ts', json: 'src/features/formatting/json.ts', pretty: 'src/features/formatting/pretty.ts',
	server: 'src/features/enriching/dynamic-providers/server.ts', redaction: 'src/features/redacting/apply-rules.ts',
	sinks: 'src/sinks/index.ts', remote: 'src/public/production-remote-transferring.ts',
	batching: 'src/features/transferring/batching.ts', retry: 'src/features/transferring/retry.ts',
	http: 'src/sinks/providers/http.ts', loki: 'src/sinks/providers/loki.ts'
})
const source = Object.freeze({
	development: entries.development, production: entries.production, custom: entries.custom,
	remote: entries.remote, batching: entries.batching, retry: entries.retry, http: entries.http, loki: entries.loki,
	json: entries.json, pretty: entries.pretty, redaction: entries.redaction, sinks: entries.sinks
})
const budget = (initialMinified, initialBrotli, totalMinified, totalBrotli) =>
	Object.freeze({initialMinified, initialBrotli, totalMinified, totalBrotli})

await runScenarioSizeAudit({
	label: 'Logging', slug: 'logging', entries,
	scenarios: [
		{name: 'root registration initial load', initial: ['root'], initialRequired: [entries.root],
			initialExcluded: [source.development, source.production, source.custom, source.remote, source.http, source.loki], budgets: budget(16_200, 5_500, 16_200, 5_500)},
		{name: 'development default', initial: ['development'], selected: ['pretty', 'redaction'],
			required: [source.pretty, source.redaction], excluded: [source.remote, source.http, source.loki], budgets: budget(41_100, 15_750, 48_600, 18_800)},
		{name: 'production initial/stdout', initial: ['production'], selected: ['server', 'json', 'redaction'],
			required: [source.json, source.redaction], excluded: [source.remote, source.http, source.loki, source.batching, source.retry], budgets: budget(53_800, 20_450, 60_050, 22_950)},
		{name: 'production HTTP', initial: ['production'], selected: ['server', 'json', 'redaction', 'sinks', 'http', 'remote', 'batching', 'retry'],
			required: [source.sinks, source.http, source.remote, source.batching, source.retry], excluded: [source.loki], budgets: budget(53_800, 20_450, 85_500, 32_600)},
		{name: 'production Loki', initial: ['production'], selected: ['server', 'json', 'redaction', 'sinks', 'loki', 'remote', 'batching', 'retry'],
			required: [source.sinks, source.loki, source.remote, source.batching, source.retry], excluded: [source.http], budgets: budget(53_800, 20_450, 87_850, 33_600)},
		{name: 'custom stdout', initial: ['custom'], selected: ['json', 'redaction'], excluded: [source.http, source.loki], budgets: budget(69_450, 25_450, 75_000, 27_600)},
		{name: 'custom HTTP', initial: ['custom'], selected: ['json', 'redaction', 'sinks', 'http', 'batching', 'retry'],
			required: [source.http, source.batching, source.retry], excluded: [source.loki], budgets: budget(69_450, 25_450, 89_200, 33_500)},
		{name: 'custom Loki', initial: ['custom'], selected: ['json', 'redaction', 'sinks', 'loki', 'batching', 'retry'],
			required: [source.loki, source.batching, source.retry], excluded: [source.http], budgets: budget(69_450, 25_450, 91_550, 34_500)}
	]
})
