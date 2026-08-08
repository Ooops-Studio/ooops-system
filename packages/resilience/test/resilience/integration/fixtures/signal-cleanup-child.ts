import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'

import {waitForAbortableDelay} from '../../../../src/resilience/core/abortable-delay'
import {createBulkheadEngine} from '../../../../src/resilience/core/bulkhead'
import {createTimeoutEngine} from '../../../../src/resilience/core/timeout'

const uncaught: string[] = []
const unhandled: string[] = []
process.on('uncaughtException', (error) => { uncaught.push(error.message) })
process.on('unhandledRejection', (error) => { unhandled.push(error instanceof Error ? error.message : String(error)) })

function hostileSignal(): AbortSignal {
	const signal = new AbortController().signal
	Object.defineProperty(signal, 'removeEventListener', {
		value: () => { throw new Error('cleanup failed') }
	})
	return signal
}

function asyncSignal(): AbortSignal {
	return {
		aborted: false,
		addEventListener: async() => { throw new Error('async install failed') },
		removeEventListener: async() => { throw new Error('async cleanup failed') }
	} as unknown as AbortSignal
}

async function boundedResult(promise: Promise<unknown>): Promise<string> {
	return await Promise.race([
		promise.then(() => 'resolved', (error: unknown) => {
			return typeof error === 'object' && error !== null && 'reason' in error ? String(error.reason) : 'rejected'
		}),
		new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 50))
	])
}

const delay = await boundedResult(waitForAbortableDelay(5, hostileSignal()))
const bulkhead = createBulkheadEngine({
	clock: createFixedClock(0),
	config: {maxConcurrent: 1, maxQueueSize: 1, overflowStrategy: 'reject', queueTimeoutMs: 5}
})
const owner = await bulkhead.acquire('child', 'resource', 'child')
const queued = await boundedResult(bulkhead.acquire('child', 'resource', 'child', {signal: hostileSignal()}))
bulkhead.release('child', 'resource', 'child', owner.permit!)
const delayInstall = await boundedResult(waitForAbortableDelay(5, asyncSignal()))
const secondOwner = await bulkhead.acquire('child', 'resource', 'child')
const queuedInstall = await boundedResult(bulkhead.acquire('child', 'resource', 'child', {signal: asyncSignal()}))
bulkhead.release('child', 'resource', 'child', secondOwner.permit!)
const timeout = createTimeoutEngine({clock: createFixedClock(0)})
const timeoutInstall = await boundedResult(timeout.withTimeout(async() => 'unused', 10, {
	resource: 'child', operationKind: 'external.http'
}, {parentSignal: asyncSignal()}))
const timeoutCleanup = await boundedResult(timeout.withTimeout(async() => 'ok', 10, {
	resource: 'child', operationKind: 'external.http'
}, {parentSignal: hostileSignal()}))
await new Promise<void>((resolve) => setImmediate(resolve))

console.log(`OOOPS_RESILIENCE_SIGNAL=${JSON.stringify({delay, queued, delayInstall, queuedInstall, timeoutInstall, timeoutCleanup, uncaught, unhandled})}`)
if (delay !== 'resolved' || queued !== 'queue-timeout' || delayInstall !== 'rejected' || queuedInstall !== 'rejected' || timeoutInstall !== 'rejected' || timeoutCleanup !== 'resolved' || uncaught.length > 0 || unhandled.length > 0) process.exitCode = 1
