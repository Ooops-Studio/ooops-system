import {describe, expect, it, vi} from 'vitest'

import {
	clonePerformanceValue,
	DB_EVENT_PREFIX,
	isDBEvent,
	isResourceSnapshotEvent
} from '../../../../src/performance/core/utils/event-helpers'

describe('event-helpers', () => {

	describe('DB_EVENT_PREFIX', () => {

		it('should be "db."', () => {

			expect(DB_EVENT_PREFIX).toBe('db.')
		})
	})

	describe('isDBEvent', () => {

		it('should return true for DB event names', () => {

			expect(isDBEvent('db.query')).toBe(true)
			expect(isDBEvent('db.insert')).toBe(true)
			expect(isDBEvent('db.update')).toBe(true)
			expect(isDBEvent('db.delete')).toBe(true)
			expect(isDBEvent('db.')).toBe(true)
		})

		it('should return false for non-DB event names', () => {

			expect(isDBEvent('http.request')).toBe(false)
			expect(isDBEvent('api.call')).toBe(false)
			expect(isDBEvent('event')).toBe(false)
			expect(isDBEvent('')).toBe(false)
		})

		it('should handle edge cases', () => {

			expect(isDBEvent('db')).toBe(false)
			expect(isDBEvent('database.query')).toBe(false)
			expect(isDBEvent('dbquery')).toBe(false)
		})
	})

	it('identifies only internal resource snapshot events', () => {
		expect(isResourceSnapshotEvent('runtime', 'cpu_usage')).toBe(true)
		expect(isResourceSnapshotEvent('runtime', 'memory_usage')).toBe(true)
		expect(isResourceSnapshotEvent('mark', 'cpu_usage')).toBe(false)
		expect(isResourceSnapshotEvent('runtime', 'event_loop_lag')).toBe(false)
	})

	it('clones structured and non-cloneable performance payloads without sharing plain mutable state', () => {
		const cloneable = {labels: {scope: 'original'}}
		expect(clonePerformanceValue(cloneable)).toEqual(cloneable)
		expect(clonePerformanceValue(null)).toBeNull()
		expect(clonePerformanceValue('value')).toBe('value')

		const circular: {self?: unknown; items: unknown[]; nested: Record<string, unknown>} = {
			items: [() => true, new Date(0)],
			nested: Object.assign(Object.create(null), {value: 'original'}) as Record<string, unknown>
		}
		circular.self = circular
		const cloned = clonePerformanceValue(circular)
		expect(cloned).not.toBe(circular)
		expect(cloned.self).toBe(cloned)
		expect(cloned.nested).not.toBe(circular.nested)
		expect(cloned.items[1]).not.toBe(circular.items[1])
		expect(cloned.items[1]).toStrictEqual(circular.items[1])
	})

	it('tolerates hostile custom metadata during fallback cloning', () => {
		const ownKeys = vi.fn(() => { throw new Error('keys failed') })
		const hostileKeys = new Proxy({}, {ownKeys})
		const hostilePrototype = new Proxy({}, {getPrototypeOf: () => { throw new Error('prototype failed') }})
		const throwingProperty = Object.defineProperty({}, 'value', {enumerable: true, get: () => { throw new Error('get failed') }})
		const value = {fn: () => true, hostileKeys, hostilePrototype, throwingProperty}
		expect(() => clonePerformanceValue(value)).not.toThrow()
		expect(ownKeys).not.toHaveBeenCalled()
	})

	it('does not invoke accessors or retain revoked proxies while bounding payloads', () => {
		const getter = expect.unreachable
		const accessor = Object.defineProperty({}, 'secret', {enumerable: true, get: getter})
		const {proxy, revoke} = Proxy.revocable({secret: 'value'}, {})
		revoke()
		const cloned = clonePerformanceValue({accessor, proxy, huge: 'x'.repeat(100_000)})

		expect(cloned.accessor).toEqual({})
		expect(cloned.proxy).toBeUndefined()
		expect(cloned.huge.length).toBeLessThanOrEqual(1_024)
	})
})
