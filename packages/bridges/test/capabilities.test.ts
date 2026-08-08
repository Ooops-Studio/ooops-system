import {describe, expect, it, vi} from 'vitest'

import {captureBridgeMethod, createBoundedBridgeInvoker, snapshotBridgeOptions} from '../src/internal/capabilities'

describe('bridge capabilities', () => {
	it('captures receiver methods without invoking accessors', () => {
		const target = {
			value: 2,
			method(this: {value: number}, input: number) { return this.value + input }
		}
		const method = captureBridgeMethod<(input: number) => number>(target, 'method')
		expect(method?.(3)).toBe(5)
		let reads = 0
		const hostile = Object.defineProperty({}, 'method', {get() { reads += 1; return vi.fn() }})
		expect(captureBridgeMethod(hostile, 'method')).toBeUndefined()
		expect(reads).toBe(0)
	})

	it('accepts exact data options and rejects accessors or unknown fields', () => {
		expect(snapshotBridgeOptions({metrics: {}}, ['metrics'] as const)).toEqual({metrics: {}})
		expect(() => snapshotBridgeOptions({unknown: true}, ['metrics'] as const)).toThrow('BRIDGE_OPTIONS_INVALID')
		expect(() => snapshotBridgeOptions(Object.defineProperty({}, 'metrics', {enumerable: true, get: vi.fn()}), ['metrics'] as const))
			.toThrow('BRIDGE_OPTIONS_INVALID')
	})

	it('bounds unresolved native promises per attachment-local invoker', async() => {
		let resolve: (() => void) | undefined
		const method = vi.fn(() => new Promise<void>((done) => { resolve = done }))
		const invoke = createBoundedBridgeInvoker(method)
		invoke(); invoke()
		expect(method).toHaveBeenCalledOnce()
		resolve?.(); await Promise.resolve()
		invoke()
		expect(method).toHaveBeenCalledTimes(2)
	})
})
