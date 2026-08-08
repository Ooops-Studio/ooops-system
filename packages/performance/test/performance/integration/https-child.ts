import {createCustomPerformance} from '../../../src/performance/public/custom'
import {createHttpNdjsonPerformanceEventExporter} from '../../../src/performance/public/custom-exporters-http'

const endpoint = process.env.PERFORMANCE_ENDPOINT
if (!endpoint) throw new Error('PERFORMANCE_ENDPOINT is required')
const exporter = createHttpNdjsonPerformanceEventExporter({
	url: endpoint,
	headers: {authorization: 'Bearer integration-token'},
	timeoutMs: 2_000
})
const performance = await createCustomPerformance({
	destinations: [{name: 'https', exporter}],
	delivery: {flushIntervalMs: 0, retry: {attempts: 1, baseDelayMs: 1}, operationTimeoutMs: 2_500}
})
performance.record('request', 42, {route: '/safe', password: 'secret-value'})
await performance.flush()
await performance.shutdown()
