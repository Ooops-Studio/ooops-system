import type {JobRun} from '@ooopsstudio/core/contracts/jobs'

import type {InternalRun} from '../types/jobs'

import {clone} from './handler-helpers'

/** Read native Error messages without executing hostile accessors or proxy traps. */
export function readJobsErrorMessage(error: unknown): string {
	try {
		if (!(error instanceof Error)) return ''
		let current: object | null = error
		for (let depth = 0; current && depth < 32; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
			if (descriptor) {
				return 'value' in descriptor && typeof descriptor.value === 'string'
					? descriptor.value
					: ''
			}
			current = Object.getPrototypeOf(current)
		}
	} catch { /* hostile error object */ }
	return ''
}

export function projectJobFailure(error: unknown): string {
	const message = readJobsErrorMessage(error)
	if (message.startsWith('Job timed out after ')) return 'task_timeout'
	if (message === 'Task not registered' || message.startsWith('Task not registered:')) {
		return 'task_not_registered'
	}
	if (message.startsWith('Jobs lease lost') || message.startsWith('Jobs lease renewal failed')) {
		return 'lease_lost'
	}
	if (message === 'Jobs scheduler shutdown grace period expired') return 'shutdown_interrupted'
	return 'task_failed'
}

export const toPublicRun = (run: InternalRun): JobRun => ({
	id: run.id,
	task: run.task,
	queue: run.queue,
	payload: clone(run.payload),
	status: run.status,
	createdAt: run.createdAt,
	updatedAt: run.updatedAt,
	runAt: run.runAt,
	priority: run.priority,
	attempt: run.attempt,
	maxAttempts: run.maxAttempts,
	...(run.scheduleId ? {scheduleId: run.scheduleId} : {}),
	...(run.output !== undefined ? {output: clone(run.output)} : {}),
	...((run.failureCode ?? run.error) ? {failureCode: run.failureCode ?? run.error} : {}),
	...(run.cancelReason ? {cancelReason: run.cancelReason} : {}),
	...(run.startedAt !== undefined ? {startedAt: run.startedAt} : {}),
	...(run.completedAt !== undefined ? {completedAt: run.completedAt} : {}),
	...(run.terminalAt !== undefined ? {terminalAt: run.terminalAt} : {})
})
