/** One authenticated OTLP/HTTP destination. Transport behavior is preset-controlled. */
export interface OtlpRemoteConfig {
	readonly endpoint: string
	readonly headers?: Readonly<Record<string, string>>
}
