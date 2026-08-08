import type {ManagedLifecycle} from '@ooopsstudio/core/ports/lifecycle'

import {createLifecycleHandler} from '../core/lifecycle-handler'
import type {CustomLifecycleOptions} from '../types/lifecycle'
import {createCustomOptions} from '../utils/preset-helpers'

export function createCustomLifecycle(options: CustomLifecycleOptions): ManagedLifecycle {
	return createLifecycleHandler(createCustomOptions(options))
}

export type {CustomLifecycleOptions} from '../types/lifecycle'
