import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

const state = vi.hoisted(() => ({options: [] as Array<Record<string, unknown>>, stops: [] as Array<ReturnType<typeof vi.fn>>}))

vi.mock('../../../../src/performance/features/core/event-loop-monitor', () => ({createEventLoopMonitor: (options: Record<string, unknown>) => { state.options.push(options); const stop = vi.fn(); state.stops.push(stop); return {start: vi.fn(), stop} }}))
vi.mock('../../../../src/performance/features/core/gc-monitor', () => ({createGCMonitor: (options: Record<string, unknown>) => { state.options.push(options); const stop = vi.fn(() => { throw new Error('stop') }); state.stops.push(stop); return {start: vi.fn(), stop} }}))
vi.mock('../../../../src/performance/features/core/resource-monitor', () => ({createResourceMonitor: (options: Record<string, unknown>) => { state.options.push(options); const stop = vi.fn(); state.stops.push(stop); return {start: vi.fn(), stop} }}))

import {createHighResClock} from '../../../../src/performance/core/clock'
import {createMonitors, stopAllMonitors} from '../../../../src/performance/core/runtime/monitors'

describe('lean runtime monitors', () => {
	it('creates all fixed monitors, isolates observers, and cleans all up', () => {
		const monitors = createMonitors({
			clock: createHighResClock({clock: createFixedClock(1)}),
			onPerfEvent: () => { throw new Error('event') },
			onSaturationAlert: () => { throw new Error('alert') },
			errors: {report: vi.fn()},
			enableEventLoopMonitor: true,
			enableGCMonitor: true,
			enableResourceMonitor: true
		})
		expect(() => (state.options[0]?.onPerfEvent as (event: unknown) => void)({})).not.toThrow()
		expect(() => (state.options[0]?.onSaturationAlert as (alert: unknown) => void)({})).not.toThrow()
		expect(() => stopAllMonitors(monitors)).not.toThrow()
		expect(state.stops).toHaveLength(3)
	})

	it('supports a monitor-free configuration', () => {
		const monitors = createMonitors({
			clock: createHighResClock(),
			onPerfEvent: vi.fn(),
			enableEventLoopMonitor: false,
			enableGCMonitor: false,
			enableResourceMonitor: false
		})
		expect(monitors).toEqual({})
		expect(() => stopAllMonitors(monitors)).not.toThrow()
	})
})
