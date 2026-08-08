import type {JobsRuntime} from '@ooopsstudio/core/ports/jobs'

import type {JobsHandlerOptions} from '../types/jobs'

import {createJobsRuntime} from './handler'
import {createJobsScheduling} from './handler-scheduling'

export function createCustomJobsHandler(options: JobsHandlerOptions): JobsRuntime {
	return createJobsRuntime(options, createJobsScheduling)
}
