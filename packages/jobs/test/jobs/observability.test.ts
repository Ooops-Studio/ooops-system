import type {ManagedJobs} from '@ooopsstudio/core/ports/jobs'
import {describe, expect, it, vi} from 'vitest'

import {attachJobsObservability} from '../../src/jobs/public/observability'
import {
	createJobsTelemetryController,
	registerJobsTelemetryTarget
} from '../../src/jobs/runtime-capabilities'

describe('Jobs observability attachment', () => {
	it('emits bounded raw events and isolates listener failures', () => {
		const jobs = {} as ManagedJobs
		const controller = createJobsTelemetryController()
		registerJobsTelemetryTarget(jobs, controller)
		const events: string[] = []
		const dispose = attachJobsObservability(jobs, (event) => {
			events.push(event.kind)
			if (event.kind === 'retry') throw new Error('isolated')
		})
		controller.emit({kind: 'enqueued', result: 'success'})
		controller.emit({kind: 'execution', result: 'completed'})
		controller.emit({kind: 'retry'})
		controller.emit({kind: 'active', count: 1})
		controller.emit({kind: 'rejected', reason: 'capacity'})
		controller.emit({kind: 'operation_failed', operation: 'backend', code: 'JOBS_BACKEND_FAILED', reportable: true})
		controller.emit({kind: 'finalization_failed', operation: 'shutdown', code: 'JOBS_FINALIZATION_FAILED'})
		expect(events).toEqual(['enqueued', 'execution', 'retry', 'active', 'rejected',
			'operation_failed', 'finalization_failed'])
		dispose(); dispose()
	})

	it('allows only one attachment per runtime', () => {
		const jobs = {} as ManagedJobs
		registerJobsTelemetryTarget(jobs, createJobsTelemetryController())
		const listener = vi.fn()
		const dispose = attachJobsObservability(jobs, listener)
		expect(() => attachJobsObservability(jobs, listener)).toThrow('already attached')
		dispose()
		expect(() => attachJobsObservability(jobs, listener)).not.toThrow()
	})
})
