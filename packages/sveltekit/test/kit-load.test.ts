import {describe, expect, it, vi} from 'vitest'

import {buildServerLabels, resolveSvelteRoute} from '../src/labels'
import {
	instrumentAction,
	instrumentLoad
} from '../src/server'

describe('svelte load and action helpers', () => {
	it('bounds route inputs before URL parsing and rejects invalid runtime metadata', () => {
		expect(resolveSvelteRoute(undefined, `https://example.com/${'x'.repeat(10_000)}`)).toBe('/')
		expect(resolveSvelteRoute(Symbol('route') as never, Symbol('url') as never)).toBe('/')
	})

	it('drops invalid and prototype-sensitive custom label keys', () => {
		const labels = Object.create(null) as Record<string, string>
		labels.safe_key = 'kept'
		labels['bad\nkey'] = 'dropped'
		labels.__proto__ = 'dropped'
		labels.constructor = 'dropped'

		expect(buildServerLabels('load', '/health', labels)).toEqual({
			safe_key: 'kept', runtime: 'server', kind: 'load', route: '/health'
		})
	})

	it('executes load and action exactly once when tracing duplicates or suppresses callbacks', async() => {
		const span = {} as never
		const loadWork = vi.fn(async() => 'loaded')
		const actionWork = vi.fn(async() => 'acted')
		const duplicatedTracing = {
			inSpan: async(_name: string, operation: (activeSpan: never) => Promise<unknown>) => {
				await operation(span)
				return await operation(span)
			}
		} as never
		const suppressedTracing = {inSpan: async() => undefined} as never
		const event = {url: new URL('https://example.com/projects/1')}

		await expect(instrumentLoad(loadWork, {tracing: duplicatedTracing})(event)).resolves.toBe('loaded')
		await expect(instrumentAction(actionWork, {tracing: suppressedTracing})(event)).resolves.toBe('acted')
		expect(loadWork).toHaveBeenCalledOnce()
		expect(actionWork).toHaveBeenCalledOnce()
	})

	it('bounds hanging tracing calls while preserving every application operation', async() => {
		const inSpan = vi.fn(async(_name: string, operation: () => Promise<unknown>) => {
			await operation()
			return await new Promise<never>(() => undefined)
		})
		const work = vi.fn(async() => 'loaded')
		const wrapped = instrumentLoad(work, {tracing: {inSpan} as never})
		const event = {url: new URL('https://example.com/projects/1')}

		const results = await Promise.all(Array.from({length: 1_000}, async() => await wrapped(event)))
		expect(results).toHaveLength(1_000)
		expect(work).toHaveBeenCalledTimes(1_000)
		expect(inSpan).toHaveBeenCalledTimes(100)
	})
	it('does not let broken measurement ports suppress or duplicate load and action work', async() => {
		const loadWork = vi.fn(async() => 'loaded')
		const actionWork = vi.fn(async() => 'acted')
		const load = instrumentLoad(loadWork, {
			performance: {measureAsync: (() => new Promise(() => undefined)) as never}
		})
		const action = instrumentAction(actionWork, {
			performance: {measureAsync: (async(_name: string, fn: () => Promise<unknown>) => {
				void fn()
				void fn()
				throw new Error('measurement failed')
			}) as never}
		})
		const event = {url: new URL('https://example.com/projects/1')}

		await expect(load(event)).resolves.toBe('loaded')
		await expect(action(event)).resolves.toBe('acted')
		expect(loadWork).toHaveBeenCalledOnce()
		expect(actionWork).toHaveBeenCalledOnce()
	})

	it('measures load functions with stable labels', async() => {
		const calls: Array<[string, Record<string, string> | undefined]> = []
		const wrapped = instrumentLoad(
			async() => ({ok: true}),
			{
				performance: {
					measureAsync: async<T>(name: string, fn: () => Promise<T>, labels?: Readonly<Record<string, string>>) => {
						calls.push([name, labels])
						return await fn()
					}
				}
			}
		)

		const result = await wrapped({
			route: {id: '/blog/[slug]'},
			url: new URL('https://example.com/blog/hello')
		})

		expect(result).toEqual({ok: true})
		expect(calls[0]).toEqual([
			'sveltekit.load',
			expect.objectContaining({
				kind: 'load',
				runtime: 'server',
				route: '/blog/:id'
			})
		])
	})

	it('preserves thrown errors from load instrumentation', async() => {
		const wrapped = instrumentLoad(async() => {
			throw new Error('boom')
		}, {
			performance: {
				measureAsync: async(_name, fn) => await fn()
			}
		})

		await expect(
			wrapped({
				route: {id: '/blog/[slug]'},
				url: new URL('https://example.com/blog/hello')
			})
		).rejects.toThrow('boom')
	})

	it('measures action functions with action labels', async() => {
		const calls: Array<[string, Record<string, string> | undefined]> = []
		const wrapped = instrumentAction(
			async() => ({success: true}),
			{
				action: 'publish',
				performance: {
					measureAsync: async(name, fn, labels) => {
						calls.push([name, labels])
						return await fn()
					}
				}
			}
		)

		const result = await wrapped({
			route: {id: '/projects/[id]'},
			url: new URL('https://example.com/projects/123')
		})

		expect(result).toEqual({success: true})
		expect(calls[0]).toEqual([
			'sveltekit.action',
			expect.objectContaining({
				action: 'publish',
				kind: 'action',
				route: '/projects/:id'
			})
		])
	})

	it('uses handler name as the default action label', async() => {
		const measureAsync = vi.fn(async(_name, fn) => await fn())
		const wrapped = instrumentAction(
			async function archive() {
				return {archived: true}
			},
			{performance: {measureAsync}}
		)

		await wrapped({
			route: {id: '/projects/[id]'},
			url: new URL('https://example.com/projects/123')
		})

		expect(measureAsync).toHaveBeenCalledWith(
			'sveltekit.action',
			expect.any(Function),
			expect.objectContaining({action: 'archive'})
		)
	})

	it('runs load and action directly when performance measurement is unavailable', async() => {
		const load = instrumentLoad(async() => 'loaded', {name: 'custom.load'})
		const action = instrumentAction(async() => 'acted', {name: 'custom.action'})
		const event = {url: new URL('https://example.com/no-route')}

		expect(await load(event)).toBe('loaded')
		expect(await action(event)).toBe('acted')
	})

	it('uses custom names, route resolvers, and anonymous action names', async() => {
		const measureAsync = vi.fn(async(_name, fn) => await fn())
		const load = instrumentLoad(async() => 'loaded', {
			name: 'custom.load',
			route: '/configured/[id]',
			labels: {scope: 'load'},
			performance: {measureAsync}
		})
		const action = instrumentAction(async() => 'acted', {
			name: 'custom.action',
			getRoute: () => '/resolved/[slug]',
			labels: {scope: 'action'},
			performance: {measureAsync}
		})

		await load({url: new URL('https://example.com')})
		await action({url: new URL('https://example.com')})

		expect(measureAsync).toHaveBeenCalledWith('custom.load', expect.any(Function), expect.objectContaining({route: '/configured/:id', scope: 'load'}))
		expect(measureAsync).toHaveBeenCalledWith('custom.action', expect.any(Function), expect.objectContaining({route: '/resolved/:id', action: '', scope: 'action'}))
	})

	it('does not allow custom labels to replace canonical route, runtime, kind, or action labels', async() => {
		const measureAsync = vi.fn(async(_name, fn) => await fn())
		const wrapped = instrumentAction(async() => 'ok', {
			action: 'publish',
			labels: {route: '/users/123?token=secret', runtime: 'browser', kind: 'raw', action: 'hijacked'},
			performance: {measureAsync}
		})

		await wrapped({route: {id: '/projects/[id]'}, url: new URL('https://example.com/projects/1')})
		expect(measureAsync).toHaveBeenCalledWith('sveltekit.action', expect.any(Function), expect.objectContaining({
			route: '/projects/:id', runtime: 'server', kind: 'action', action: 'publish'
		}))
		expect(JSON.stringify(measureAsync.mock.calls)).not.toContain('token=secret')
	})

	it('snapshots adapter options without invoking accessors or following mutation', async() => {
		const work = vi.fn(async() => 'loaded')
		const getter = vi.fn(() => { throw new Error('must not execute') })
		const options: Record<string, unknown> = {route: '/stable/[id]'}
		Object.defineProperties(options, {
			name: {enumerable: true, get: getter},
			tracing: {enumerable: true, get: getter},
			labels: {enumerable: true, get: getter}
		})
		const wrapped = instrumentLoad(work, options as never)
		options.route = '/mutated/[id]'

		await expect(wrapped({url: new URL('https://example.com/fallback')})).resolves.toBe('loaded')
		expect(work).toHaveBeenCalledOnce()
		expect(getter).not.toHaveBeenCalled()
	})

	it('ignores throwing route metadata accessors and still runs application work', async() => {
		const work = vi.fn(async() => 'loaded')
		const measureAsync = vi.fn(async(_name, fn) => await fn())
		const wrapped = instrumentLoad(work, {performance: {measureAsync}})
		const event = Object.create(null) as Record<string, unknown>
		Object.defineProperties(event, {
			route: {get: () => { throw new Error('route failed') }},
			url: {get: () => { throw new Error('url failed') }}
		})

		await expect(wrapped(event as never)).resolves.toBe('loaded')
		expect(work).toHaveBeenCalledOnce()
		expect(measureAsync).toHaveBeenCalledWith(
			'sveltekit.load', expect.any(Function), expect.objectContaining({route: '/'})
		)
	})
})
