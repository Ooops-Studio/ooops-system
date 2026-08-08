import {afterEach, describe, expect, it, vi} from 'vitest'

import {getResourceLoadAverage} from '../../../../src/performance/features/core/resource-load-average'

describe('getResourceLoadAverage', () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

	afterEach(() => {
		if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
	})

	it('skips load-average probing on Windows', () => {
		Object.defineProperty(process, 'platform', {configurable: true, value: 'win32'})
		expect(getResourceLoadAverage(vi.fn())).toBeUndefined()
	})

	it('lazily loads and then returns the Node load average', async() => {
		const onError = vi.fn()
		expect(getResourceLoadAverage(onError)).toBeUndefined()
		await vi.dynamicImportSettled()
		const loadAverage = getResourceLoadAverage(onError)
		expect(loadAverage).toHaveLength(3)
		expect(loadAverage?.every(Number.isFinite)).toBe(true)
		expect(onError).not.toHaveBeenCalled()
	})
})
