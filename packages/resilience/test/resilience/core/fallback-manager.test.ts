
import type {ResilienceOperationContext} from '@ooopsstudio/core/contracts/resilience'
import {describe, expect, it, vi} from 'vitest'

import {createCustomFallbackStage} from '../../../src/resilience/core/custom-fallback'
import {createFallbackManager} from '../../../src/resilience/core/fallback-manager'

const context: ResilienceOperationContext = {
	operationKind: 'external.http',
	resource: 'api.main',
	tenantId: 'tenant-1'
}

describe('fallback-manager', () => {
	it('snapshots strategy length without executing proxy property reads', () => {
		const lengthRead = vi.fn()
		const strategies = new Proxy([
			{condition: () => true, handler: () => 'safe', degradeLevel: 'PARTIAL' as const}
		], {
			get(target, key, receiver) {
				if (key === 'length') lengthRead()
				return Reflect.get(target, key, receiver)
			}
		})
		const fallback = createFallbackManager<string>({strategies})

		expect(lengthRead).not.toHaveBeenCalled()
		expect(fallback).toBeDefined()
	})

	it('rejects the same strategy identity repeated in one fallback chain', () => {
		const strategy = {condition: () => true, handler: () => 'unsafe-repeat', degradeLevel: 'PARTIAL' as const}

		expect(() => createFallbackManager({strategies: [strategy, strategy]})).toThrow(/Duplicate fallback strategy/u)
		expect(() => createCustomFallbackStage({chain: [strategy, strategy]})).toThrow(/Duplicate fallback strategy/u)
	})

	it('returns an unused result when no strategies are configured', async() => {

		const manager = createFallbackManager<string>({strategies: []})

		await expect(manager.tryFallback(new Error('boom'), context)).resolves.toEqual({
			used: false,
			degradeLevel: 'NONE'
		})

	})

	it('uses the first matching successful strategy and skips non-matching ones', async() => {

		const skipped = vi.fn(() => false)
		const used = vi.fn(() => true)

		const manager = createFallbackManager<string>({
			strategies: [
				{
					condition: skipped,
					handler: async() => 'skip',
					degradeLevel: 'NONE'
				},
				{
					condition: used,
					handler: async() => 'fallback-value',
					degradeLevel: 'PARTIAL'
				}
			]
		})

		await expect(manager.tryFallback(new Error('boom'), context)).resolves.toEqual({
			used: true,
			result: 'fallback-value',
			degradeLevel: 'PARTIAL',
			error: expect.any(Error)
		})

		expect(skipped).toHaveBeenCalledOnce()
		expect(used).toHaveBeenCalledOnce()

	})

	it('tries the next matching strategy when a fallback handler fails', async() => {

		const manager = createFallbackManager<string>({
			strategies: [
				{
					condition: () => true,
					handler: async() => {
						throw new Error('first failed')
					},
					degradeLevel: 'PARTIAL'
				},
				{
					condition: () => true,
					handler: async() => 'second wins',
					degradeLevel: 'OFFLINE'
				}
			]
		})

		await expect(manager.tryFallback(new Error('boom'), context)).resolves.toEqual({
			used: true,
			result: 'second wins',
			degradeLevel: 'OFFLINE',
			error: expect.any(Error)
		})

	})

	it('keeps fallback recovery running when its failure observer throws', async() => {

		const manager = createFallbackManager<string>({
			strategies: [
				{
					condition: () => true,
					handler: async() => {
						throw new Error('first failed')
					},
					degradeLevel: 'PARTIAL'
				},
				{
					condition: () => true,
					handler: async() => 'second wins',
					degradeLevel: 'OFFLINE'
				}
			],
			onFailure: () => {
				throw new Error('observer failed')
			}
		})

		await expect(manager.tryFallback(new Error('boom'), context)).resolves.toMatchObject({
			used: true,
			result: 'second wins'
		})
	})

	it('contains rejected async failure observers', async() => {
		const manager = createFallbackManager<string>({
			strategies: [{
				condition: () => true,
				handler: async() => { throw new Error('fallback failed') },
				degradeLevel: 'PARTIAL'
			}],
			onFailure: (() => Promise.reject(new Error('observer rejected'))) as never
		})

		await expect(manager.tryFallback(new Error('boom'), context)).resolves.toMatchObject({used: false})
		await Promise.resolve()
	})

	it('does not evaluate accessor-backed promise methods from failure observers', async() => {
		const catchGetter = vi.fn(() => () => undefined)
		const then = vi.fn()
		const hostile = Object.defineProperties({}, {catch: {get: catchGetter}, then: {value: then}})
		const manager = createFallbackManager<string>({
			strategies: [{
				condition: () => true,
				handler: async() => { throw new Error('fallback failed') },
				degradeLevel: 'PARTIAL'
			}],
			onFailure: (() => hostile) as never
		})
		await expect(manager.tryFallback(new Error('boom'), context)).resolves.toMatchObject({used: false})
		expect(catchGetter).not.toHaveBeenCalled()
		expect(then).not.toHaveBeenCalled()
	})

	it('reports no fallback when every matching handler fails', async() => {

		const error = new Error('boom')
		const manager = createFallbackManager<string>({
			strategies: [
				{
					condition: () => true,
					handler: async() => {
						throw new Error('fallback failed')
					},
					degradeLevel: 'PARTIAL'
				}
			]
		})

		await expect(manager.tryFallback(error, context)).resolves.toEqual({
			used: false,
			degradeLevel: 'NONE',
			error
		})

	})

	it('isolates throwing fallback conditions and continues with later strategies', async() => {

		const observer = vi.fn()
		const manager = createFallbackManager<string>({
			strategies: [
				{
					condition: () => {
						throw new Error('broken condition')
					},
					handler: async() => 'never',
					degradeLevel: 'PARTIAL'
				},
				{
					condition: () => true,
					handler: async() => 'recovered',
					degradeLevel: 'PARTIAL'
				}
			],
			onFailure: observer
		})

		await expect(manager.tryFallback(new Error('upstream'), context)).resolves.toMatchObject({
			used: true,
			result: 'recovered'
		})
		expect(observer).toHaveBeenCalledOnce()

	})

	it('rejects wide strategy objects without materializing descriptor maps', () => {
		const strategy = Object.assign(
			Object.fromEntries(Array.from({length: 20_000}, (_, index) => [`field${index}`, index])),
			{condition: () => true, handler: async() => 'value', degradeLevel: 'PARTIAL'}
		)
		const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors')
		expect(() => createFallbackManager({strategies: [strategy as never]})).toThrow(/inspected safely/u)
		expect(descriptors.mock.calls.some(([value]) => value === strategy)).toBe(false)
		descriptors.mockRestore()
	})

	it('propagates hostile cancellation reasons without prototype traversal', async() => {
		let prototypeReads = 0
		let reason: object
		reason = new Proxy({}, {getPrototypeOf: () => { prototypeReads++; return reason }})
		const controller = new AbortController()
		controller.abort(reason)
		const stage = createCustomFallbackStage({cancelled: [{
			condition: () => true,
			handler: async() => { throw new Error('fallback failed') },
			degradeLevel: 'PARTIAL'
		}]} as never)
		let failure: unknown
		try {
			await stage.run('cancelled', new Error('primary'), controller.signal, async(operation) => await operation())
		} catch(error) {
			failure = error
		}
		expect(failure).toBe(reason)
		expect(prototypeReads).toBe(0)
	})

})
