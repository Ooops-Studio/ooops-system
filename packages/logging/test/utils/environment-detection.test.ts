import type {RuntimeType} from '@ooopsstudio/core/runtime'
import {describe, it, expect, vi, beforeEach} from 'vitest'

import {detectEnvironment, isServer, isClient} from '../../src/utils/environment-detection'

vi.mock('@ooopsstudio/core/runtime', () => ({
	detectRuntime: vi.fn()
}))

describe('environment-detection', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('should detect server environment', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('node:22' as RuntimeType)

		const result = detectEnvironment()

		expect(result).toBe('server')
	})

	it('should detect client environment', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('browser' as RuntimeType)

		const result = detectEnvironment()

		expect(result).toBe('client')
	})

	it('should detect deno as server', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('deno' as RuntimeType)

		const result = detectEnvironment()

		expect(result).toBe('server')
	})

	it('should detect node runtime variants as server', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')

		vi.mocked(detectRuntime).mockReturnValue('node:18' as RuntimeType)
		expect(detectEnvironment()).toBe('server')

		vi.mocked(detectRuntime).mockReturnValue('node:20' as RuntimeType)
		expect(detectEnvironment()).toBe('server')

		vi.mocked(detectRuntime).mockReturnValue('node:22' as RuntimeType)
		expect(detectEnvironment()).toBe('server')
	})

	it('should return true for isServer when on server', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('node:22' as RuntimeType)

		expect(isServer()).toBe(true)
	})

	it('should return false for isServer when on client', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('browser' as RuntimeType)

		expect(isServer()).toBe(false)
	})

	it('should return true for isClient when on client', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('browser' as RuntimeType)

		expect(isClient()).toBe(true)
	})

	it('should return false for isClient when on server', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('node:22' as RuntimeType)

		expect(isClient()).toBe(false)
	})

	it('should handle unknown runtime types as client', async() => {
		const {detectRuntime} = await import('@ooopsstudio/core/runtime')
		vi.mocked(detectRuntime).mockReturnValue('unknown' as RuntimeType)

		const result = detectEnvironment()

		expect(result).toBe('client')
	})
})
