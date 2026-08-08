import type {NormalizedError} from '../contracts/errors'
import type {LogAttributes} from '../contracts/logging'

export interface Errors {
	report(error: NormalizedError, context?: LogAttributes): void
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}
