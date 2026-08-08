import {TOK} from '@ooopsstudio/core/tokens'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
	auditDispose: vi.fn(), cacheDispose: vi.fn(),
	audit: vi.fn(), cache: vi.fn()
}))
vi.mock('../src/audit', () => ({wireAuditObservability: mocks.audit}))
vi.mock('../src/cache', () => ({wireCacheObservability: mocks.cache}))

import {wireObservability} from '../src/observability'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.audit.mockReturnValue(mocks.auditDispose)
	mocks.cache.mockReturnValue(mocks.cacheDispose)
})

function container(values: Map<symbol, unknown>) {
	return {tryGet(token: symbol) { return values.get(token) }} as never
}

describe('aggregate observability wiring', () => {
	it('wires only present runtimes and disposes in reverse order once', async() => {
		const values = new Map<symbol, unknown>([
			[TOK.Audit, {kind: 'audit'}], [TOK.Cache, {kind: 'cache'}], [TOK.Logging, {info: vi.fn()}]
		])
		const dispose = await wireObservability(container(values))
		expect(mocks.audit).toHaveBeenCalledOnce()
		expect(mocks.cache).toHaveBeenCalledOnce()
		dispose(); dispose()
		expect(mocks.auditDispose).toHaveBeenCalledOnce()
		expect(mocks.cacheDispose).toHaveBeenCalledOnce()
		expect(mocks.cacheDispose.mock.invocationCallOrder[0]!).toBeLessThan(
			mocks.auditDispose.mock.invocationCallOrder[0]!
		)
	})

	it('rolls back earlier attachments when a later bridge fails', async() => {
		mocks.cache.mockImplementation(() => { throw new Error('conflict') })
		const values = new Map<symbol, unknown>([[TOK.Audit, {}], [TOK.Cache, {}]])
		await expect(wireObservability(container(values))).rejects.toThrow('conflict')
		expect(mocks.auditDispose).toHaveBeenCalledOnce()
	})

	it('rejects accessor-backed container methods without invoking them', async() => {
		let reads = 0
		const hostile = Object.defineProperty({}, 'tryGet', {get() { reads += 1; return vi.fn() }})
		await expect(wireObservability(hostile as never)).rejects.toThrow('OBSERVABILITY_CONTAINER_INVALID')
		expect(reads).toBe(0)
	})
})
