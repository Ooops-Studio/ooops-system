import type {ProfileCaptureOptions} from '@ooopsstudio/core/contracts/profiling'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
	capture: vi.fn(async(options: ProfileCaptureOptions) => ({
		type: 'cpu' as const, format: 'cpuprofile' as const, name: options.name ?? 'cpu',
		startedAt: 1, endedAt: 2, durationMs: 1, captured: true, payload: '{}'
	})),
	flush: vi.fn(),
	shutdown: vi.fn(),
	create: vi.fn()
}))

vi.mock('../src/inspector-profiler', () => ({
	createInspectorProfiler: mocks.create.mockImplementation(() => ({
		capture: mocks.capture, flush: mocks.flush, shutdown: mocks.shutdown
	}))
}))

import {createLazyInspectorProfiler} from '../src/lazy-inspector-profiler'

describe('lazy Inspector profiler adapter', () => {
	beforeEach(() => vi.clearAllMocks())

	it('loads Inspector only for capture and reuses the resolved profiler', async() => {
		const profiler = createLazyInspectorProfiler({now: () => 1})
		await profiler.flush?.()
		expect(mocks.create).not.toHaveBeenCalled()
		await profiler.capture({type: 'cpu', durationMs: 1})
		await profiler.capture({type: 'cpu', durationMs: 1})
		expect(mocks.create).toHaveBeenCalledOnce()
		expect(mocks.capture).toHaveBeenCalledTimes(2)
		await profiler.flush?.(); await profiler.shutdown?.()
		expect(mocks.flush).toHaveBeenCalledOnce()
		expect(mocks.shutdown).toHaveBeenCalledOnce()
	})

	it('keeps shutdown safe and construction retryable when lazy construction fails', async() => {
		mocks.create.mockImplementationOnce(() => { throw new Error('construction failed') })
		const profiler = createLazyInspectorProfiler({now: () => 1})
		await expect(profiler.capture({type: 'cpu'})).rejects.toThrow('construction failed')
		await expect(profiler.shutdown?.()).resolves.toBeUndefined()
		await expect(profiler.capture({type: 'cpu'})).resolves.toMatchObject({captured: true})
		expect(mocks.create).toHaveBeenCalledTimes(2)
	})
})
