import type {ManagedLifecycle} from '@ooopsstudio/core/ports/lifecycle'

import {createLifecycleHandler} from '../core/lifecycle-handler'
import type {StandardLifecycleOptions} from '../types/lifecycle'
import {createProductionOptions} from '../utils/preset-helpers'

export function createProductionLifecycle(options?: StandardLifecycleOptions): ManagedLifecycle {
	return createLifecycleHandler(createProductionOptions(options))
}

export type {StandardLifecycleOptions} from '../types/lifecycle'
