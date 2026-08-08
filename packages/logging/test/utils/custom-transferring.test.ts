import {describe, expect, it, vi} from 'vitest'

import {markDeliveredLines, throwIfCleanupFailed} from '../../src/utils/custom-transferring'

describe('custom transferring helpers', () => {
	it('marks every delivered line in order', () => {
		const markDelivered = vi.fn()

		markDeliveredLines(['first', 'second'], markDelivered)

		expect(markDelivered).toHaveBeenNthCalledWith(1, 'first')
		expect(markDelivered).toHaveBeenNthCalledWith(2, 'second')
	})

	it('returns for no cleanup errors and preserves one or many failures', () => {
		expect(() => throwIfCleanupFailed([], 'cleanup failed')).not.toThrow()

		const single = new Error('single')
		expect(() => throwIfCleanupFailed([single], 'cleanup failed')).toThrow(single)

		expect(() => throwIfCleanupFailed([new Error('one'), new Error('two')], 'cleanup failed'))
			.toThrow(AggregateError)
	})
})
