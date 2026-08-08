/** Signal composition used by delivery paths. */
export const composeAbortSignals = (...signals: Array<AbortSignal | undefined>): {
	signal?: AbortSignal
	cleanup: () => void
} => {
	const activeSignals = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (activeSignals.length === 0) return {cleanup: () => undefined}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (activeSignals.length === 1) return {signal: activeSignals[0], cleanup: () => undefined}

	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	const controller = new AbortController()
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	const listeners: Array<() => void> = []
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	for (const activeSignal of activeSignals) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const abort = (): void => {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			try { controller.abort(activeSignal.reason) } catch { controller.abort() }
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (activeSignal.aborted) abort()
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		else {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			activeSignal.addEventListener('abort', abort, {once: true})
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			listeners.push(() => { activeSignal.removeEventListener('abort', abort) })
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return {signal: controller.signal, cleanup: () => { for (const cleanup of listeners) cleanup() }}
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}
