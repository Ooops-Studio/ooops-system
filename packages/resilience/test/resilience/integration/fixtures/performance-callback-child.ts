import {createProductionResilience} from '../../../../src/resilience/public/production'

const unhandled: string[] = []
process.on('unhandledRejection', (error) => {
	unhandled.push(typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error))
})

let retained!: () => Promise<string>
const runtime = createProductionResilience({
	policies: [{
		name: 'child.performance', operationKind: 'external.http', timeout: {defaultMs: 100},
		retry: false, circuitBreaker: false
	}],
	performance: {
		measureAsync: (_name, callback) => {
			retained = callback as () => Promise<string>
			return Promise.resolve('diagnostic-result')
		}
	} as never
})

const result = await runtime.execute({
	operation: 'child', policy: 'child.performance', context: {resource: 'child.performance'}
}, async() => 'authoritative')

retained()
await new Promise<void>((resolve) => setImmediate(resolve))
await runtime.shutdown()
console.log(`OOOPS_RESILIENCE_PERFORMANCE=${JSON.stringify({result, unhandled})}`)
if (unhandled.length > 0) process.exitCode = 1
