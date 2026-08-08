import type {LogAttributes, LogContext} from '@ooopsstudio/core/contracts/logging'
import {describe, it, expect, vi} from 'vitest'

import {
	copyLogAttributes,
	copyLogTags,
	mergeAttributes,
	mergeTags,
	mergeContext
} from '../../src/utils/enriching'

describe('enriching utils', () => {
	describe('mergeAttributes', () => {
		it('bounds top-level attributes before the redaction stage', () => {
			const attributes = Object.fromEntries(
				Array.from({length: 1_050}, (_, index) => [`field-${index}`, index])
			)

			const snapshot = copyLogAttributes(attributes)

			expect(Object.keys(snapshot ?? {})).toHaveLength(1_001)
			expect(snapshot).toMatchObject({
				'field-0': 0,
				'field-999': 999,
				__truncated__: '[Truncated]'
			})
			expect(snapshot).not.toHaveProperty('field-1000')
		})

		it('creates a bounded deep snapshot without retaining caller objects', () => {
			const nested = {value: 'safe'}
			const attributes = {
				nested,
				large: 'x'.repeat(100_000),
				branches: Array.from({length: 2_000}, (_, index) => ({index}))
			} as unknown as LogAttributes

			const snapshot = copyLogAttributes(attributes) as Record<string, unknown>
			nested.value = 'mutated-after-admission'

			expect(snapshot.nested).not.toBe(nested)
			expect(JSON.stringify(snapshot)).not.toContain('mutated-after-admission')
			expect(JSON.stringify(snapshot).length).toBeLessThan(50_000)
		})

		it('should snapshot base when patch is undefined', () => {
			const base: LogAttributes = {service: 'test'}
			const result = mergeAttributes(base, undefined)
			expect(result).toEqual(base)
			expect(result).not.toBe(base)
		})

		it('should return patch when base is undefined', () => {
			const patch: LogAttributes = {service: 'test'}
			const result = mergeAttributes(undefined, patch)
			expect(result).toEqual(patch)
		})

		it('should merge base and patch attributes', () => {
			const base: LogAttributes = {service: 'test', version: '1.0.0'}
			const patch: LogAttributes = {version: '2.0.0', env: 'prod'}
			const result = mergeAttributes(base, patch)
			expect(result).toEqual({
				service: 'test',
				version: '2.0.0',
				env: 'prod'
			})
		})

		it('should handle empty objects', () => {
			const result = mergeAttributes({}, {})
			expect(result).toEqual({})
		})

		it('should mask hostile attributes during merge', () => {
			const base = new Proxy({safe: 'ok'}, {
				ownKeys() {
					throw new Error('base ownKeys failed')
				}
			}) as unknown as LogAttributes
			const patch = {}
			Object.defineProperty(patch, 'secret', {
				enumerable: true,
				get() {
					throw new Error('patch getter failed')
				}
			})

			const result = mergeAttributes(base, patch as LogAttributes)

			expect(result).toEqual({
				unserializableAttributes: '[Unserializable]',
				secret: '[Unserializable]'
			})
		})
	})

	describe('mergeTags', () => {
		it('does not stringify hostile non-string tags', () => {
			const stringify = vi.fn(() => 'leaked')
			const tags = [{toString: stringify}] as unknown as string[]
			expect(copyLogTags(tags)).toEqual(['[Unserializable]'])
			expect(stringify).not.toHaveBeenCalled()
		})

		it('bounds hostile declared lengths', () => {
			let reads = 0
			const tags = new Proxy([], {
				get(target, property, receiver) {
					if (property === 'length') return 1_000_000
					if (typeof property === 'string' && /^\d+$/u.test(property)) reads += 1
					return Reflect.get(target, property, receiver)
				}
			})
			expect(copyLogTags(tags)).toEqual([])
			expect(reads).toBe(0)
		})

		it('should snapshot base when patch is undefined', () => {
			const base = ['tag1', 'tag2']
			const result = mergeTags(base, undefined)
			expect(result).toEqual(base)
			expect(result).not.toBe(base)
		})

		it('should return patch when base is undefined', () => {
			const patch = ['tag1', 'tag2']
			const result = mergeTags(undefined, patch)
			expect(result).toEqual(patch)
		})

		it('should merge tags with deduplication by default', () => {
			const base = ['tag1', 'tag2']
			const patch = ['tag2', 'tag3']
			const result = mergeTags(base, patch)
			expect(result).toEqual(['tag1', 'tag2', 'tag3'])
		})

		it('should merge tags without deduplication when disabled', () => {
			const base = ['tag1', 'tag2']
			const patch = ['tag2', 'tag3']
			const result = mergeTags(base, patch, false)
			expect(result).toEqual(['tag1', 'tag2', 'tag2', 'tag3'])
		})

		it('bounds the final result when individually valid tag sets are merged', () => {
			const base = Array.from({length: 100}, (_, index) => `base-${index}`)
			const patch = Array.from({length: 100}, (_, index) => `patch-${index}`)

			expect(mergeTags(base, patch)).toEqual([
				...base,
				'[Truncated]'
			])
			expect(mergeTags(base, patch, false)).toHaveLength(101)
		})

		it('should handle empty arrays', () => {
			const result = mergeTags([], [])
			expect(result).toEqual([])
		})

		it('should mask hostile tags during merge', () => {
			const base = new Proxy(['base'], {
				get(target, property, receiver) {
					if (property === '0') throw new Error('base tag failed')
					return Reflect.get(target, property, receiver)
				}
			})
			const patch = new Proxy(['patch'], {
				get(target, property, receiver) {
					if (property === 'length') throw new Error('patch length failed')
					return Reflect.get(target, property, receiver)
				}
			})

			const result = mergeTags(base, patch)

			expect(result).toEqual(['base', 'patch'])
		})
	})

	describe('mergeContext', () => {
		it('should merge namespace', () => {
			const base: LogContext = {namespace: 'base.ns'}
			const patch = {namespace: 'patch.ns'}
			const result = mergeContext(base, patch)
			expect(result.namespace).toBe('patch.ns')
		})

		it('should merge attributes', () => {
			const base: LogContext = {attributes: {service: 'test'}}
			const patch = {attributes: {version: '1.0.0'}}
			const result = mergeContext(base, patch)
			expect(result.attributes).toEqual({
				service: 'test',
				version: '1.0.0'
			})
		})

		it('should merge tags', () => {
			const base: LogContext = {tags: ['tag1']}
			const patch = {tags: ['tag2']}
			const result = mergeContext(base, patch)
			expect(result.tags).toEqual(['tag1', 'tag2'])
		})

		it('should handle undefined base', () => {
			const patch = {namespace: 'test', attributes: {service: 'test'}}
			const result = mergeContext(undefined, patch)
			expect(result).toEqual(patch)
		})

		it('should handle empty patch', () => {
			const base: LogContext = {namespace: 'test'}
			const result = mergeContext(base, {})
			expect(result).toEqual(base)
		})
	})

})
