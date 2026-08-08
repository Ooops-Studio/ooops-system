import {describe, expect, it, vi} from 'vitest'

import {createCardinalityTracker} from '../../src/utils/cardinality-tracker'

describe('createCardinalityTracker', () => {
	it('rejects oversized label values before creating retained identity keys', () => {
		const tracker = createCardinalityTracker({now: () => 1})
		expect(() => tracker.check('bounded_metric', {
			user: 'x'.repeat(1_000_000)
		}, {maxLabels: 10, maxCardinality: 10})).toThrow('string values')
		expect(tracker.getDiagnostics()).toEqual([])
	})

	it('rejects malformed options and runtime inputs deterministically', () => {
		expect(() => createCardinalityTracker(null as never)).toThrow('options must be an object')
		expect(() => createCardinalityTracker({now: 1 as never})).toThrow('now must be a function')
		expect(() => createCardinalityTracker({clock: {} as never})).toThrow('provide now')
		expect(() => createCardinalityTracker({maxSeries: 0})).toThrow('maxSeries')
		expect(() => createCardinalityTracker({maxSeries: 100_001})).toThrow('maxSeries')
		const nowAccessor = vi.fn(() => () => 0)
		const accessorOptions = Object.defineProperty({}, 'now', {enumerable: true, get: nowAccessor})
		expect(() => createCardinalityTracker(accessorOptions as never)).toThrow('stable known data fields')
		expect(nowAccessor).not.toHaveBeenCalled()
		expect(() => createCardinalityTracker({unknown: true} as never)).toThrow('stable known data fields')
		const tracker = createCardinalityTracker({now: () => 0})
		expect(() => tracker.check('metric', {bad: 1 as never}, {
			maxLabels: 1, maxCardinality: 1
		})).toThrow('string values')
		expect(() => tracker.check('metric', {}, null as never)).toThrow('limits must be an object')
		expect(() => tracker.check('metric', {}, {maxLabels: 1, maxCardinality: 1}, undefined, 0))
			.toThrow('weight')
		expect(() => tracker.check('metric', {}, {maxLabels: 1, maxCardinality: 1}, undefined, 1, 0))
			.toThrow('weight')
		expect(() => tracker.getDiagnostics(-1)).toThrow('limit is invalid')
	})

	it('bounds estimated snapshot bytes globally and releases their retained weight', () => {
		const tracker = createCardinalityTracker({now: () => 0})
		const limits = {maxLabels: 1, maxCardinality: 10}
		const onDrop = vi.fn()
		const mebibyte = 1024 * 1024

		expect(tracker.check('first', {id: '1'}, limits, onDrop, 1, 10 * mebibyte)).toBe(false)
		expect(tracker.check('second', {id: '2'}, limits, onDrop, 1, 8 * mebibyte)).toBe(true)
		expect(onDrop).toHaveBeenLastCalledWith('second', 'max_snapshot_bytes')
		expect(tracker.release('first', {id: '1'})).toBe(true)
		expect(tracker.check('second', {id: '2'}, limits, onDrop, 1, 8 * mebibyte)).toBe(false)
	})

	it('bounds expanded export records through their minimum byte weight', () => {
		const tracker = createCardinalityTracker({now: () => 0})
		const limits = {maxLabels: 1, maxCardinality: 10}
		const onDrop = vi.fn()

		expect(tracker.check('first', {id: '1'}, limits, onDrop, 15_000)).toBe(false)
		expect(tracker.check('second', {id: '2'}, limits, onDrop, 10_000)).toBe(true)
		expect(onDrop).toHaveBeenLastCalledWith('second', 'max_snapshot_bytes')
		expect(tracker.getDiagnostics()).toEqual([
			{metricName: 'first', combinations: 1, dropped: 0}
		])
		expect(tracker.release('first', {id: '1'})).toBe(true)
		expect(tracker.check('second', {id: '2'}, limits, onDrop, 10_000)).toBe(false)
	})

	it('enforces a global series ceiling across metric names and resets it', () => {
		const tracker = createCardinalityTracker({now: () => 0, maxSeries: 2})
		const limits = {maxLabels: 1, maxCardinality: 10}
		const onDrop = vi.fn()
		expect(tracker.check('first', {id: '1'}, limits)).toBe(false)
		expect(tracker.check('second', {id: '2'}, limits)).toBe(false)
		expect(tracker.check('first', {id: '3'}, limits, onDrop)).toBe(true)
		expect(onDrop).toHaveBeenCalledWith('first', 'max_global_cardinality')
		tracker.reset()
		expect(tracker.check('third', {id: '3'}, limits)).toBe(false)
	})

	it('does not retain globally rejected metric names after capacity is released', () => {
		const tracker = createCardinalityTracker({now: () => 0, maxSeries: 1})
		const limits = {maxLabels: 1, maxCardinality: 10}
		expect(tracker.check('accepted', {id: '1'}, limits)).toBe(false)
		for (let index = 0; index < 1_100; index += 1) {
			expect(tracker.check(`rejected_${index}`, {id: '2'}, limits)).toBe(true)
		}

		expect(tracker.getDiagnostics(1_000)).toEqual([
			{metricName: 'accepted', combinations: 1, dropped: 0}
		])
		expect(tracker.release('accepted', {id: '1'})).toBe(true)
		expect(tracker.check('recovered', {id: '3'}, limits)).toBe(false)
		expect(tracker.getDiagnostics()).toEqual([
			{metricName: 'recovered', combinations: 1, dropped: 0}
		])
	})

	it('rejects accessor-backed labels without invoking them', () => {
		const tracker = createCardinalityTracker({now: () => 0})
		const getter = vi.fn(() => 'secret')
		const labels = Object.defineProperty({}, 'token', {enumerable: true, get: getter})

		expect(() => tracker.check('metric', labels as never, {maxLabels: 1, maxCardinality: 1}))
			.toThrow('string values')
		expect(getter).not.toHaveBeenCalled()
	})
	it('tracks unique combinations, drops excess cardinality, and resets diagnostics', () => {
		let now = 0
		const tracker = createCardinalityTracker({now: () => now})
		const onDrop = vi.fn()
		const limits = {maxLabels: 2, maxCardinality: 1}

		expect(tracker.check('requests', {route: '/a'}, limits)).toBe(false)
		now += 1
		expect(tracker.check('requests', {route: '/a'}, limits)).toBe(false)
		expect(tracker.check('requests', {route: '/b'}, limits, onDrop)).toBe(true)
		expect(onDrop).toHaveBeenCalledWith('requests', 'max_cardinality')
		expect(tracker.getDiagnostics()).toEqual([{metricName: 'requests', combinations: 1, dropped: 1}])
		tracker.reset()
		expect(tracker.getDiagnostics(0)).toEqual([])
	})

	it('isolates throwing drop observers and uses the supplied clock', () => {
		const tracker = createCardinalityTracker({clock: {now: () => 42}})
		const limits = {maxLabels: 1, maxCardinality: 1}
		tracker.check('metric', {label: 'one'}, limits)
		expect(() => tracker.check('metric', {label: 'two'}, limits, () => { throw new Error('observer') })).not.toThrow()
		expect(tracker.getDiagnostics(1)[0]).toMatchObject({metricName: 'metric', dropped: 1})
	})

	it('bounds metric names without forgetting cardinality for older metrics', () => {
		let now = 0
		const tracker = createCardinalityTracker({now: () => ++now})
		const limits = {maxLabels: 1, maxCardinality: 1}
		for (let index = 0; index < 1_000; index += 1) {
			expect(tracker.check(`metric-${index}`, {label: String(index)}, limits)).toBe(false)
		}
		const onDrop = vi.fn()
		expect(tracker.check('overflow', {label: 'new'}, limits, onDrop)).toBe(true)
		expect(onDrop).toHaveBeenCalledWith('overflow', 'max_metric_names')
		expect(tracker.check('metric-0', {label: 'second'}, limits, onDrop)).toBe(true)
		expect(onDrop).toHaveBeenCalledWith('metric-0', 'max_cardinality')
		expect(tracker.getDiagnostics(1_000)).toHaveLength(1_000)
	})
})
