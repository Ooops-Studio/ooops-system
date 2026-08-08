import {isDeepStrictEqual} from 'node:util'

import type {TriggeredScheduleResult} from '../types/backend'

import {validateJobsCollectionSize} from './handler-collection-limits'
import type {JobsKernelContext} from './handler-context'
import {validateStoredJobRun} from './handler-helpers'
import {validateStoredSchedule} from './handler-schedule-validation'

export function processTriggeredSchedules(
	context: JobsKernelContext,
	triggered: unknown,
	maximumRuns: number,
	generatedRuns: ReadonlyMap<string, unknown>
): void {
	if (!Array.isArray(triggered) || triggered.length > 100) {
		throw new Error('Jobs backend returned an invalid schedule trigger batch')
	}
	validateJobsCollectionSize(triggered, 'schedule trigger results')
	const scheduleIds = new Set<string>()
	const runIds = new Set<string>()
	const validatedRuns = []
	for (const candidate of triggered) {
		const item = candidate as TriggeredScheduleResult
		if (!item || !Array.isArray(item.runs) || item.runs.length > maximumRuns
			|| !Array.isArray(item.triggerTimes) || item.triggerTimes.length > maximumRuns) {
			throw new Error('Jobs backend returned an invalid schedule trigger result')
		}
		validateStoredSchedule(item.schedule)
		if (!context.tasks.has(item.schedule.task)) {
			throw new Error('Jobs backend returned a schedule for an unregistered task')
		}
		const misfire = item.schedule.policy?.misfire ?? 'fire-once'
		const overlap = item.schedule.policy?.overlap ?? 'queue'
		if (!context.options.schedulePolicy.misfire.includes(misfire)
			|| !context.options.schedulePolicy.overlap.includes(overlap)) {
			throw new Error('Jobs backend returned an unsupported persisted schedule policy')
		}
		if (scheduleIds.has(item.schedule.id)) throw new Error('Jobs backend returned duplicate schedule triggers')
		scheduleIds.add(item.schedule.id)
		if (item.runs.length !== item.triggerTimes.length
			|| new Set(item.runs.map((run) => run.id)).size !== item.runs.length
			|| new Set(item.triggerTimes).size !== item.triggerTimes.length) {
			throw new Error('Jobs backend returned an inconsistent schedule trigger result')
		}
		for (let index = 0; index < item.runs.length; index++) {
			const run = item.runs[index]!
			const expectedQueue = item.schedule.queue
				?? context.tasks.get(item.schedule.task)?.definition.queue
				?? context.options.defaultQueue
				?? 'default'
			validateStoredJobRun(run)
			const generated = generatedRuns.get(run.id)
			if (!generated || !isDeepStrictEqual(run, generated)) {
				throw new Error('Jobs backend returned a run that was not generated for this schedule trigger')
			}
			if (runIds.has(run.id)) {
				throw new Error('Jobs backend returned duplicate schedule run ids')
			}
			runIds.add(run.id)
			if (run.scheduleId !== item.schedule.id || run.runAt !== item.triggerTimes[index]
				|| run.task !== item.schedule.task || run.queue !== expectedQueue) {
				throw new Error('Jobs backend returned an inconsistent schedule trigger result')
			}
		}
		validatedRuns.push(...item.runs)
	}
	if (validatedRuns.length > 10_000) throw new Error('Jobs backend returned too many scheduled runs')
	validateJobsCollectionSize(validatedRuns, 'schedule trigger batch')
	if (!context.control.destroyed && !context.control.draining) {
		for (const run of validatedRuns) {
			context.metric('jobs_runs_enqueued_total', undefined, {queue: run.queue, task: run.task})
		}
	}
}
