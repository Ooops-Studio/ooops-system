import {runScenarioSizeAudit} from '../../scripts/scenario-size-audit.mjs'

const entries = Object.freeze({
	root: 'src/index.ts', development: 'src/public/development.ts', production: 'src/public/production.ts',
	prometheusProduction: 'src/public/production-prometheus.ts', otlpProduction: 'src/public/production-otlp.ts',
	custom: 'src/public/custom.ts', prometheusSink: 'src/sinks/prometheus.ts', otlpSink: 'src/sinks/otlp.ts',
	httpAdapter: 'src/sinks/prometheus-http.ts'
})
const prometheus = ['src/sinks/prometheus.ts', 'src/features/exporters/prometheus-exporter.ts']
const otlpCore = ['src/features/exporters/otlp-exporter.ts', 'src/features/exporters/otlp-http.ts']
const otlp = ['src/sinks/otlp.ts', ...otlpCore]
const httpAdapter = ['src/sinks/prometheus-http.ts', 'src/http/prometheus-http-server.ts']
const presets = [entries.development, entries.production, entries.prometheusProduction, entries.otlpProduction, entries.custom]
const budget = (initialMinified, initialBrotli, totalMinified, totalBrotli) =>
	Object.freeze({initialMinified, initialBrotli, totalMinified, totalBrotli})

await runScenarioSizeAudit({
	label: 'Metrics', slug: 'metrics', entries,
	scenarios: [
		{name: 'root registration initial load', initial: ['root'], initialRequired: [entries.root],
			initialExcluded: [...presets, ...prometheus, ...otlp, ...httpAdapter], budgets: budget(4_000, 2_000, 4_000, 2_000)},
		{name: 'development', initial: ['development'], required: prometheus, excluded: [...otlp, ...httpAdapter], budgets: budget(104_600, 28_000, 104_600, 28_000)},
		{name: 'aggregate production initial', initial: ['production'], excluded: [...prometheus, ...otlp, ...httpAdapter], budgets: budget(7_000, 3_000, 7_000, 3_000)},
		{name: 'production Prometheus', initial: ['prometheusProduction'], required: prometheus,
			excluded: [...otlp, ...httpAdapter], budgets: budget(105_200, 28_100, 105_200, 28_100)},
		{name: 'production OTLP', initial: ['otlpProduction'], required: otlpCore,
			excluded: [...prometheus, ...httpAdapter], budgets: budget(109_800, 30_000, 109_800, 30_000)},
		{name: 'custom exporter/core', initial: ['custom'], excluded: [...prometheus, ...otlp, ...httpAdapter], budgets: budget(90_400, 24_000, 90_400, 24_000)},
		{name: 'custom Prometheus', initial: ['custom'], selected: ['prometheusSink'], required: prometheus,
			excluded: [...otlp, ...httpAdapter], budgets: budget(90_400, 24_000, 107_450, 29_000)},
		{name: 'custom OTLP', initial: ['custom'], selected: ['otlpSink'], required: otlp,
			excluded: [...prometheus, ...httpAdapter], budgets: budget(90_400, 24_000, 113_250, 31_000)},
		{name: 'standalone Prometheus sink', initial: ['prometheusSink'], required: prometheus,
			excluded: [...otlp, ...httpAdapter], budgets: budget(37_650, 11_200, 37_650, 11_200)},
		{name: 'standalone OTLP sink', initial: ['otlpSink'], required: otlp,
			excluded: [...prometheus, ...httpAdapter], budgets: budget(43_450, 14_000, 43_450, 14_000)},
		{name: 'standalone Prometheus HTTP adapter', initial: ['httpAdapter'], required: httpAdapter,
			excluded: [...prometheus, ...otlp], budgets: budget(12_000, 4_075, 12_000, 4_075)}
	]
})
