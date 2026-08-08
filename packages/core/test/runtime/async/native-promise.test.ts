import {runInNewContext} from 'node:vm'

import {describe, expect, it, vi} from 'vitest'

import {
	captureNativePromiseResult,
	containNativePromiseUnchecked,
	createNativePromise,
	deferNativePromise,
	mapNativePromise,
	isolateUnexpectedThenable,
	raceNativePromises
} from '../../../src/runtime/async/native-promise'

function hostileCrossRealmPromise(species: () => PromiseConstructor): Promise<string> {
	return runInNewContext(`
		Object.defineProperty(Promise, Symbol.species, {
			configurable: true,
			get: species
		})
		Promise.resolve('result')
	`, {species}) as Promise<string>
}

describe('native promise public helper input isolation', () => {
	it('contains rejected promises supplied as invalid helper capabilities', async() => {
		const executor = Promise.reject(new Error('executor rejected'))
		await expect(createNativePromise(executor as never)).rejects.toThrow(TypeError)

		const fulfilled = Promise.reject(new Error('fulfilled callback rejected'))
		const rejected = Promise.reject(new Error('rejected callback rejected'))
		await expect(mapNativePromise(Promise.resolve('value'), fulfilled as never, rejected as never))
			.rejects.toThrow(TypeError)

		const orphan = Promise.reject(new Error('race entry rejected'))
		await expect(raceNativePromises([null as never, orphan])).rejects.toThrow('dense')
		await Promise.resolve()
	})

	it('rejects an accessor-backed race entry without invoking it', async() => {
		const getter = vi.fn(() => Promise.resolve('result'))
		const values: Promise<string>[] = []
		Object.defineProperty(values, '0', {configurable: true, enumerable: true, get: getter})
		Object.defineProperty(values, 'length', {value: 1})

		await expect(raceNativePromises(values)).rejects.toThrow('dense native Promises')
		expect(getter).not.toHaveBeenCalled()
	})

	it('bounds the number of race entries', async() => {
		await expect(raceNativePromises(new Array(4_097))).rejects.toThrow('at most 4096')
	})

	it('preserves dense race inspection after the global String function is rewired', async() => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'String')!
		let raced: Promise<string> | undefined
		try {
			Object.defineProperty(globalThis, 'String', {
				configurable: true, writable: true, value: () => { throw new Error('poisoned String') }
			})
			raced = raceNativePromises([Promise.resolve('first'), Promise.resolve('second')])
		} finally { Object.defineProperty(globalThis, 'String', descriptor) }

		await expect(raced).resolves.toBe('first')
	})

	it('does not execute a hostile cross-realm species getter in public helpers', async() => {
		const species = vi.fn(() => Promise)
		const promise = hostileCrossRealmPromise(species)

		await expect(mapNativePromise(promise, String, String)).rejects.toThrow('requires a native Promise')
		await expect(raceNativePromises([promise])).rejects.toThrow('dense native Promises')
		await expect(deferNativePromise(() => promise)).rejects.toThrow('must return a native Promise')
		expect(() => containNativePromiseUnchecked(promise)).not.toThrow()
		expect(species).not.toHaveBeenCalled()
	})

	it('rejects a value made thenable after its source promise settled without invoking it', async() => {
		const then = vi.fn()
		const value: {then?: typeof then} = {}
		const source = Promise.resolve(value)
		Object.defineProperty(value, 'then', {value: then})

		await expect(captureNativePromiseResult(source)).rejects.toThrow('unsafe thenable value')
		expect(then).not.toHaveBeenCalled()
	})

	it('does not propagate fulfilled values while observing native promise settlement', async() => {
		const then = vi.fn()
		const first: {then?: typeof then} = {}
		const second: {then?: typeof then} = {}
		const isolated = Promise.resolve(first)
		const contained = Promise.resolve(second)
		Object.defineProperty(first, 'then', {value: then})
		Object.defineProperty(second, 'then', {value: then})

		expect(isolateUnexpectedThenable(isolated)).toBe(true)
		expect(() => containNativePromiseUnchecked(contained)).not.toThrow()
		await Promise.resolve()
		expect(then).not.toHaveBeenCalled()
	})

	it('contains rejected native promises returned by synchronous mapping callbacks', async() => {
		const mapped = mapNativePromise(
			Promise.resolve('value'),
			() => Promise.reject(new Error('callback failed')) as never,
			String
		)
		await expect(mapped).rejects.toThrow('unsafe thenable value')
		await Promise.resolve()
	})

	it('contains rejected native promises used as rejection reasons', async() => {
		const explicitReason = Promise.reject(new Error('explicit reason'))
		const explicit = createNativePromise<never>((_resolve, reject) => { reject(explicitReason) })
		await expect(explicit).rejects.toBe(explicitReason)

		const thrownReason = Promise.reject(new Error('thrown reason'))
		const thrown = createNativePromise<never>(() => { throw thrownReason })
		await expect(thrown).rejects.toBe(thrownReason)

		const nestedReason = Promise.reject(new Error('nested reason'))
		const nested = Promise.reject(nestedReason)
		containNativePromiseUnchecked(nested)

		let rejectSelf!: (reason: unknown) => void
		const selfReason = new Promise<never>((_resolve, reject) => { rejectSelf = reject })
		rejectSelf(selfReason)
		containNativePromiseUnchecked(selfReason)
		await Promise.resolve()
	})
})
