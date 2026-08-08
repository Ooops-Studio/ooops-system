import {describe, expect, it, vi} from 'vitest'

import {
	measureClick,
	measureSubmit,
	measureVisible
} from '../src/actions'

type NodeEventListener = (event: Event) => void
type ObserverCallback = ConstructorParameters<typeof globalThis.IntersectionObserver>[0]
type ObserverInstance = InstanceType<typeof globalThis.IntersectionObserver>
type ObserverEntry = globalThis.IntersectionObserverEntry
type GlobalWithOptionalObserver = Omit<typeof globalThis, 'IntersectionObserver'> & {
	IntersectionObserver: typeof globalThis.IntersectionObserver | undefined
}
type DomElement = globalThis.Element

class MockNode {
	listeners = new Map<string, NodeEventListener>()

	addEventListener(type: string, listener: globalThis.EventListenerOrEventListenerObject) {
		this.listeners.set(type, listener as NodeEventListener)
	}

	removeEventListener(type: string) {
		this.listeners.delete(type)
	}

	dispatch(type: string) {
		this.listeners.get(type)?.(new Event(type))
	}
}

describe('svelte actions', () => {
	it('observes rejected promises returned by sync-typed record ports', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static override get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejected = new TrackedPromise((_resolve, reject) => reject(new Error('record failed')))
		try {
			const node = new MockNode()
			measureClick(node, {name: 'ui.click', performance: {record: (() => rejected) as never}})
			node.dispatch('click')
			expect(speciesReads).toBeGreaterThan(0)
		} finally {
			await rejected.catch(() => undefined)
		}
	})

	it('measures click events and tears down listeners', () => {
		const record = vi.fn()
		const node = new MockNode()
		const action = measureClick(node, {
			name: 'ui.click',
			route: '/projects/123',
			performance: {record}
		})

		node.dispatch('click')
		expect(record).toHaveBeenCalledWith(
			'ui.click',
			1,
			expect.objectContaining({kind: 'click', route: '/projects/:id'})
		)

		action.destroy()
		expect(node.listeners.size).toBe(0)
	})

	it('updates submit action options without leaking listeners', () => {
		const record = vi.fn()
		const node = new MockNode()
		const action = measureSubmit(node, {
			name: 'form.submit',
			performance: {record}
		})

		action.update({
			name: 'form.publish',
			performance: {record}
		})
		node.dispatch('submit')

		expect(record).toHaveBeenCalledWith(
			'form.publish',
			1,
			expect.objectContaining({kind: 'submit'})
		)
		expect(node.listeners.size).toBe(1)
	})

	it('fails open when DOM listener setup or cleanup throws', () => {
		const node = {
			addEventListener: vi.fn(() => { throw new Error('setup failed') }),
			removeEventListener: vi.fn(() => { throw new Error('cleanup failed') })
		}

		let action: ReturnType<typeof measureClick> | undefined
		expect(() => { action = measureClick(node, {name: 'ui.click'}) }).not.toThrow()
		expect(() => action?.update({name: 'ui.updated'})).not.toThrow()
		expect(() => action?.destroy()).not.toThrow()
	})

	it('measures visibility with IntersectionObserver and disconnects on destroy', () => {
		const record = vi.fn()
		const observe = vi.fn()
		const disconnect = vi.fn()
		let callback: ObserverCallback | undefined

		class MockIntersectionObserver {
			constructor(nextCallback: ObserverCallback) {
				callback = nextCallback
			}

			observe = observe
			disconnect = disconnect
		}

		const globalWithObserver = globalThis as GlobalWithOptionalObserver
		const original = globalWithObserver.IntersectionObserver
		globalWithObserver.IntersectionObserver =
			MockIntersectionObserver as unknown as typeof globalThis.IntersectionObserver

		const node = {} as DomElement
		const action = measureVisible(node, {
			name: 'hero.visible',
			performance: {record}
		})

		callback?.([
			{isIntersecting: true} as ObserverEntry,
			{isIntersecting: true} as ObserverEntry
		], {} as ObserverInstance)

		expect(observe).toHaveBeenCalledWith(node)
		expect(record).toHaveBeenCalledWith(
			'hero.visible',
			1,
			expect.objectContaining({kind: 'visible'})
		)
		expect(record).toHaveBeenCalledTimes(1)

		action.destroy()
		expect(disconnect).toHaveBeenCalled()
		globalWithObserver.IntersectionObserver = original
	})

	it('supports once actions and explicit visibility fallback without IntersectionObserver', () => {
		const record = vi.fn()
		const node = new MockNode()
		const action = measureClick(node, {name: 'once', once: true, eventLabel: 'cta', performance: {record}})
		node.dispatch('click')
		node.dispatch('click')
		expect(record).toHaveBeenCalledTimes(1)
		action.update({name: 'updated', labels: {source: 'test'}, performance: {record}})
		node.dispatch('click')
		expect(record).toHaveBeenCalledWith('updated', 1, expect.objectContaining({source: 'test'}))

		const globalWithObserver = globalThis as GlobalWithOptionalObserver
		const original = globalWithObserver.IntersectionObserver
		globalWithObserver.IntersectionObserver = undefined
		const callsBeforeVisibility = record.mock.calls.length
		const visible = measureVisible({} as DomElement, {name: 'fallback-visible', performance: {record}, threshold: 0, rootMargin: '10px'})
		expect(record).toHaveBeenCalledTimes(callsBeforeVisibility)
		visible.destroy()
		const explicitFallback = measureVisible({} as DomElement, {
			name: 'fallback-visible', performance: {record}, fallback: 'record'
		})
		expect(record).toHaveBeenCalledWith('fallback-visible', 1, expect.objectContaining({kind: 'visible'}))
		explicitFallback.destroy()
		globalWithObserver.IntersectionObserver = original
	})

	it('fails open when IntersectionObserver construction is broken', () => {
		class BrokenIntersectionObserver {
			constructor() { throw new Error('observer unavailable') }
		}
		const globalWithObserver = globalThis as GlobalWithOptionalObserver
		const original = globalWithObserver.IntersectionObserver
		globalWithObserver.IntersectionObserver =
			BrokenIntersectionObserver as unknown as typeof globalThis.IntersectionObserver
		try {
			expect(() => measureVisible({} as DomElement, {name: 'visible'})).not.toThrow()
		} finally {
			globalWithObserver.IntersectionObserver = original
		}
	})
})
