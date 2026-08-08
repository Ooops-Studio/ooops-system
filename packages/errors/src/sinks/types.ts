import type {EnrichedError} from '../types/normalized-error'

export interface ErrorSink {
	capture(error: EnrichedError): Promise<void>
	flush?(): Promise<void>
	close?(): Promise<void>
}

export interface SentryErrorSinkConfig {
	readonly dsn: string
	readonly environment?: string
	readonly release?: string
	readonly serverName?: string
	readonly requestTimeoutMs?: number
	readonly tags?: Readonly<Record<string, string>>
}
