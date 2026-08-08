/* v8 ignore start -- type-only declarations have no runtime behavior. */
export interface BatchingPolicy {
	maxBatch: number
	maxIntervalMs: number
	maxBytes: number
}

export interface RetryPolicy {
	maxAttempts: number
	baseDelayMs: number
	multiplier: number
	maxDelayMs: number
	jitter: number
	attemptTimeoutMs: number
}

export interface BatchRecord {
	line: string
}

export interface BatchingState {
	batch: string[]
	batchBytes: number
	flushTimer: number | ReturnType<typeof setTimeout> | undefined
	addLine: (
		line: string,
		queue: string[],
		queueSize: {value: number},
		queuedBytes: {value: number}
	) => void
	forceFlush: () => Promise<void>
}
/* v8 ignore stop */
