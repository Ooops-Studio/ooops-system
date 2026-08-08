export interface FaroBrowserClient {
	readonly api: {
		pushEvent(
			name: string,
			attributes?: Readonly<Record<string, string>>,
			domain?: string
		): void
		pushError(error: Error, options?: {
			readonly type?: string
			readonly context?: Readonly<Record<string, string>>
		}): void
		pushLog(messages: unknown[], options?: {
			readonly level?: unknown
			readonly context?: Readonly<Record<string, string>>
		}): void
		setUser(user?: {
			readonly id?: string
			readonly email?: string
			readonly username?: string
			readonly attributes?: Readonly<Record<string, string>>
		}): void
	}
}
