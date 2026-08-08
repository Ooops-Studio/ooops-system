import {describe, expect, it} from 'vitest'

import {createBoundedFailureBuffer} from '../../src/utils/bounded-failures'

describe('bounded logging failure buffer', () => {
	it('bounds retained failures, reports overflow, and resets after drain', () => {
		const buffer = createBoundedFailureBuffer<string>('test writes', 2)
		buffer.push('first')
		buffer.push('second')
		buffer.push('third')
		buffer.push('fourth')

		expect(buffer.drain()).toEqual([
			'first',
			'second',
			expect.objectContaining({message: 'test writes: 2 additional failures omitted'})
		])
		expect(buffer.drain()).toEqual([])
	})

	it('reports a single overflow and validates the bound', () => {
		const buffer = createBoundedFailureBuffer<string>('test write', 1)
		buffer.push('first')
		buffer.push('second')
		expect(buffer.drain()[1]).toEqual(expect.objectContaining({message: 'test write: 1 additional failures omitted'}))

		for (const maximum of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
			expect(() => createBoundedFailureBuffer('invalid', maximum)).toThrow('positive safe integer')
		}
	})
})
