import {createSafeAbortController} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {createTimeoutEngine} from '../../../../src/resilience/core/timeout'
import {createProductionResilience} from '../../../../src/resilience/public/production'

const uncaught: string[] = []
const unhandled: string[] = []
let thenCalls = 0
let listenerAccessorCalls = 0
process.on('uncaughtException', (error) => { uncaught.push(error instanceof Error ? error.message : String(error)) })
process.on('unhandledRejection', (error) => { unhandled.push(error instanceof Error ? error.message : String(error)) })

function installHostileListeners(signal: AbortSignal, label: string): Promise<never> {
	const removed = () => { throw new Error(`${label} removed`) }
	signal.addEventListener('abort', removed)
	signal.removeEventListener('abort', removed)
	signal.addEventListener('abort', () => { throw new Error(`${label} listener`) })
	signal.addEventListener('abort', async() => { throw new Error(`${label} async listener`) })
	signal.addEventListener('abort', () => ({then: () => { thenCalls++; throw new Error(`${label} hostile then`) }}))
	signal.addEventListener('abort', {handleEvent: () => { throw new Error(`${label} listener object`) }})
	signal.addEventListener('abort', Object.defineProperty({}, 'handleEvent', {
		get: () => { listenerAccessorCalls++; return () => undefined }
	}) as {handleEvent(event: Event): void})
	const functionListener = () => undefined
	Object.defineProperty(functionListener, 'call', {get: () => { listenerAccessorCalls++; return () => undefined }})
	signal.addEventListener('abort', functionListener)
	signal.onabort = () => { throw new Error(`${label} onabort`) }
	return new Promise((_, reject) => {
		signal.addEventListener('abort', () => reject(new Error(`${label} settled`)), {once: true})
	})
}

function code(error: unknown): string {
	return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
}

const runtime = createProductionResilience({
	policies: [{
		name: 'child.timeout', operationKind: 'external.http', timeout: {defaultMs: 10},
		retry: false, circuitBreaker: false
	}]
})
const fetchController = createSafeAbortController()
const fetchResult = await (await fetch('data:text/plain,native', {signal: fetchController.signal})).text()
let managed = 'resolved'
try {
	await runtime.execute({operation: 'child', policy: 'child.timeout', context: {resource: 'child.remote'}},
		async(signal) => await installHostileListeners(signal, 'managed'))
} catch(error) { managed = code(error) }
await runtime.shutdown()

const timeout = createTimeoutEngine({clock: {now: () => 0}})
let standalone = 'resolved'
try {
	await timeout.withTimeout(async(signal) => await installHostileListeners(signal, 'standalone'), 10, {
		resource: 'child.remote', operationKind: 'external.http'
	})
} catch(error) { standalone = error instanceof Error ? error.name : 'unknown' }

await new Promise<void>((resolve) => setImmediate(resolve))
console.log(`OOOPS_RESILIENCE_ABORT=${JSON.stringify({fetchResult, managed, standalone, thenCalls, listenerAccessorCalls, uncaught, unhandled})}`)
if (uncaught.length > 0 || unhandled.length > 0) process.exitCode = 1
