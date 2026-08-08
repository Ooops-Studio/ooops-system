import {createStandardResilience, type StandardResilienceOptions} from './standard'
import type {ManagedResilience} from './types'

export interface ProductionResilienceOptions extends StandardResilienceOptions {}

export function createProductionResilience(options: ProductionResilienceOptions = {}): ManagedResilience {
	return createStandardResilience(options)
}
