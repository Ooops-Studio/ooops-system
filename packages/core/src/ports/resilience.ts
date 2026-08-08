/** @file Resilience capability boundary. */

import type {ResilienceExecutionRequest} from '../contracts/resilience'

export type ResilienceOperation<T> = (signal: AbortSignal) => Promise<T>

/** Minimal, application-facing resilience capability. */
export interface ResiliencePort {
	execute<T>(request: ResilienceExecutionRequest, fn: ResilienceOperation<T>): Promise<T>
}
