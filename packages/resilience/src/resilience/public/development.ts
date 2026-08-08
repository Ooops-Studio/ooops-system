import {createStandardResilience, type StandardResilienceOptions} from './standard'
import type {ManagedResilience} from './types'

export interface DevelopmentResilienceOptions extends StandardResilienceOptions {}

export function createDevelopmentResilience(options: DevelopmentResilienceOptions = {}): ManagedResilience {
	return createStandardResilience(options)
}
