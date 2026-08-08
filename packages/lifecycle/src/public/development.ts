import type {ManagedLifecycle} from '@ooopsstudio/core/ports/lifecycle'

import {createLifecycleHandler} from '../core/lifecycle-handler'
import type {StandardLifecycleOptions} from '../types/lifecycle'
import {createDevelopmentOptions} from '../utils/preset-helpers'

export function createDevelopmentLifecycle(options?: StandardLifecycleOptions): ManagedLifecycle {
	return createLifecycleHandler(createDevelopmentOptions(options))
}

export type {StandardLifecycleOptions} from '../types/lifecycle'
