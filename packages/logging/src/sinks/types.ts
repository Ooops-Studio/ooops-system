export interface LokiLoggingSinkConfig {
	readonly provider: 'loki'
	readonly url: string
	readonly headers?: Readonly<Record<string, string>>
	readonly defaultLabels?: Readonly<Record<string, string>>
	readonly requestTimeoutMs?: number
	readonly keepalive?: boolean
}

export interface HttpLoggingSinkConfig {
	readonly provider: 'http'
	readonly url: string
	readonly headers?: Readonly<Record<string, string>>
	readonly requestTimeoutMs?: number
	readonly keepalive?: boolean
}

export type LoggingSinkConfig =
	| LokiLoggingSinkConfig
	| HttpLoggingSinkConfig
