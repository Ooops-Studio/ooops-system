export type RateLimitHeaders = Readonly<Record<string, string>>

export interface RateLimit429ResponseMeta {
	readonly status: 429
	readonly reason: 'rate_limit_exceeded'
	readonly policy: string
	readonly headers: RateLimitHeaders
	readonly retryAfterMs: number | null
	readonly retryAfterSeconds: number | null
	readonly resetAt: number | null
}
