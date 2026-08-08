import type {JobsRuntime} from '@ooopsstudio/core/ports/jobs'

import type {JobsHandlerOptions} from '../types/jobs'

import {createJobsRuntime} from './handler'
import {createBasicJobsScheduling} from './handler-basic-scheduling'

export function createBasicJobsHandler(options: JobsHandlerOptions): JobsRuntime {
	return createJobsRuntime(options, createBasicJobsScheduling)
}
