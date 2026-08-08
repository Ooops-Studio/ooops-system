import {describe, expect, it, vi} from 'vitest'

import {detectRuntime} from '../../../src/runtime/runtime/lifecycle-detection'

describe('lifecycle runtime detection', () => {
	it('classifies the runtime without installing process-global ownership', () => {
		const before = {
			SIGINT: process.listenerCount('SIGINT'),
			SIGTERM: process.listenerCount('SIGTERM')
		}
		expect(['node:dev', 'node:prod', 'node:test', 'browser', 'deno', 'unknown']).toContain(detectRuntime())
		expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
		expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
	})

	it('contains throwing Node runtime observations', () => {
		const versions = Object.getOwnPropertyDescriptor(process, 'versions')
		Object.defineProperty(process, 'versions', {
			configurable: true,
			get: () => { throw new Error('poisoned runtime') }
		})
		try {
			expect(() => detectRuntime()).not.toThrow()
			expect(detectRuntime()).toBe('unknown')
		} finally {
			if (versions) Object.defineProperty(process, 'versions', versions)
		}
		vi.restoreAllMocks()
	})
})
