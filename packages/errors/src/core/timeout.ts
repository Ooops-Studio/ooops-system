export type ErrorsFinalizationStage = 'report' | 'deduplication' | 'flush' | 'shutdown'

export class ErrorsFinalizationTimeoutError extends Error {
	readonly code = 'ERRORS_FINALIZATION_TIMEOUT'
	readonly stage: ErrorsFinalizationStage

	constructor(stage: ErrorsFinalizationStage, timeoutMs: number) {
		super(`Errors ${stage} timed out after ${timeoutMs}ms.`)
		this.name = 'ErrorsFinalizationTimeoutError'
		this.stage = stage
	}
}

export function withErrorsTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	stage: ErrorsFinalizationStage
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new ErrorsFinalizationTimeoutError(stage, timeoutMs)), timeoutMs)
		try { timer.unref?.() } catch { /* optional event-loop optimization */ }
	})
	return Promise.race([operation, timeout]).finally(() => {
		if (timer !== undefined) {
			try { clearTimeout(timer) } catch { /* cleanup cannot replace the operation result */ }
		}
	})
}

export function isErrorsTimeout(error: unknown, stage: ErrorsFinalizationStage): boolean {
	try {
		return error instanceof ErrorsFinalizationTimeoutError && error.stage === stage
	} catch {
		// Custom integrations may reject with hostile proxies. Timeout
		// classification is part of cleanup and must itself be total.
		return false
	}
}
