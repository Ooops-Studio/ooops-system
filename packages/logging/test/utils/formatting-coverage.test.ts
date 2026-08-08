import {describe, expect, it} from 'vitest'

import {normalizeFormattingValue} from '../../src/features/formatting/safe-value'
import {formatTimestamp, resetRelativeStart} from '../../src/utils/formatting'

describe('format timestamp coverage', () => {
	it('supports reset, json, unix, relative, and iso timestamps', () => {
		resetRelativeStart(1_000)
		expect(formatTimestamp(2_500, 'json')).toBe('2500')
		expect(formatTimestamp(2_500, 'pretty', 'unix')).toBe('2500')
		expect(formatTimestamp(2_500, 'pretty', 'relative')).toBe('+1.500s')
		resetRelativeStart()
		expect(formatTimestamp(5_000, 'pretty', 'relative')).toBe('+0.000s')
		expect(formatTimestamp(0, 'pretty', 'iso')).toBe('1970-01-01T00:00:00.000Z')
	})

	it('keeps hostile non-finite formatting limits bounded', () => {
		const deeplyNested = {one: {two: {three: 'value'}}}
		expect(normalizeFormattingValue(deeplyNested, {maxDepth: Number.NaN})).toEqual(deeplyNested)
		expect(normalizeFormattingValue(deeplyNested, {maxDepth: Number.POSITIVE_INFINITY})).toEqual(deeplyNested)
		expect(normalizeFormattingValue(deeplyNested, {maxDepth: -1})).toBe('[MaxDepth]')
		expect(normalizeFormattingValue(['a', 'b'], {maxArrayLength: -1})).toEqual(['[MaxArrayLength]'])
	})
})
