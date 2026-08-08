import {addJobsCollectionRecordSize} from './handler-collection-limits'
import type {JobsKernelContext} from './handler-context'
import {addJobsDuration, clone} from './handler-helpers'
import {processTriggeredSchedules} from './handler-schedule-results'

export function createBasicJobsScheduling(context: JobsKernelContext) {
	return {
		async triggerDueSchedules(): Promise<void> {
			const now = context.now()
			let generatedBytes = 0
			const generatedRuns = new Map<string, unknown>()
			const triggered = await context.withProducerSpan('jobs.schedule.trigger', {triggerTime: now}, async() => context.options.backend.triggerDueSchedules({
				now, maxCatchUp: 1,
				allowedTasks: [...context.tasks.keys()],
				misfireGraceMs: Math.min(2_147_483_647, (context.options.pollIntervalMs ?? 250) * 2),
				allowedMisfire: context.options.schedulePolicy.misfire,
				allowedOverlap: context.options.schedulePolicy.overlap,
				terminalExpiresAt: context.options.terminalRetentionMs === undefined ? undefined
					: addJobsDuration(now, context.options.terminalRetentionMs, 'Jobs terminal expiry'),
				createRun: (schedule, time) => {
					if (time > now) throw new Error('Jobs backend supplied a future schedule trigger time')
					const run = context.createRun(schedule.task, schedule.payload ?? {}, {
						queue: schedule.queue, runAt: time, scheduleId: schedule.id
					})
					if (generatedRuns.size >= 10_000 || generatedRuns.has(run.id)) {
						throw new Error('Jobs schedule trigger generated too many runs')
					}
					generatedBytes = addJobsCollectionRecordSize(generatedBytes, run, 'schedule trigger batch')
					generatedRuns.set(run.id, clone(run))
					return run
				}
			}))
			processTriggeredSchedules(context, triggered, 1, generatedRuns)
		}
	}
}
