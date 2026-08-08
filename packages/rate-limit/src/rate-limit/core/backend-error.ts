export class RateLimitBackendError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'RateLimitBackendError'
	}
}

export function isRateLimitBackendError(error: unknown): error is RateLimitBackendError {
	return error instanceof RateLimitBackendError
}
