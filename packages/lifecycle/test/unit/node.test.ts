import {afterEach, describe, expect, it, vi} from 'vitest'

import {createCustomLifecycle} from '../../src/public/custom'
import {attachNodeLifecycle} from '../../src/public/node'

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function runtime() {
	const clock = {now: Date.now}
	return createCustomLifecycle({
		clock,
		monotonicClock: clock,
		shutdown: {drainGracePeriodMs: 0}
	})
}

describe('explicit Node lifecycle adapter', () => {
	it('owns signals once and removes exactly its listeners', async() => {
		const clock = {now: Date.now}
		const lifecycle = createCustomLifecycle({
			clock, monotonicClock: clock,
			shutdown: {drainGracePeriodMs: 0, groups: ['custom-only']}
		})
		const before = process.listenerCount('SIGTERM')
		const dispose = attachNodeLifecycle(lifecycle, {signals: ['SIGTERM']})
		disposers.push(dispose)
		expect(process.listenerCount('SIGTERM')).toBe(before + 1)
		expect(() => attachNodeLifecycle(runtime())).toThrow('LIFECYCLE_NODE_OWNER_EXISTS')

		dispose()
		expect(process.listenerCount('SIGTERM')).toBe(before)
		dispose()
	})

	it('runs bounded fatal diagnostics, shutdown and host-owned termination', async() => {
		const lifecycle = runtime()
		const diagnostic = vi.fn()
		const terminate = vi.fn()
		const dispose = attachNodeLifecycle(lifecycle, {
			signals: [],
			fatalErrors: {timeoutMs: 100, onFatalError: diagnostic, terminate}
		})
		disposers.push(dispose)
		await lifecycle.start()

		process.emit('unhandledRejection', new Error('token=secret'), Promise.resolve())
		process.emit('unhandledRejection', new Error('second'), Promise.resolve())
		await vi.waitFor(() => expect(terminate).toHaveBeenCalledWith(1))
		expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.any(Error), 'unhandledRejection')
		expect(terminate).toHaveBeenCalledOnce()
		expect(lifecycle.getStatus().state).toBe('closed')
	})

	it('still terminates when a hostile Error throws from diagnostic accessors', async() => {
		const lifecycle = runtime()
		const diagnostic = vi.fn()
		const terminate = vi.fn()
		const dispose = attachNodeLifecycle(lifecycle, {
			signals: [],
			fatalErrors: {timeoutMs: 100, onFatalError: diagnostic, terminate}
		})
		disposers.push(dispose)
		await lifecycle.start()
		const hostile = new Error('hidden')
		Object.defineProperty(hostile, 'message', {get: () => { throw new Error('getter failed') }})
		Object.defineProperty(hostile, 'name', {get: () => { throw new Error('getter failed') }})

		process.emit('uncaughtException', hostile)

		await vi.waitFor(() => expect(terminate).toHaveBeenCalledWith(1))
		expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({message: 'Fatal process error'}), 'uncaughtException')
		expect(lifecycle.getStatus().state).toBe('closed')
	})
})
