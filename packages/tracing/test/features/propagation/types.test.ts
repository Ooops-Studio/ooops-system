/**
 * @file Runtime coverage test for propagation types module.
 */

import {describe, expect, it} from 'vitest'

import {tracingPropagationTypesRuntime} from '../../../src/features/propagation/types'

describe('propagation types runtime marker', () => {

	it('should expose the runtime marker', () => {

		expect(tracingPropagationTypesRuntime).toBe(true)
	})
})
