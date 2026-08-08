/** Wait for a retry interval, but let cancellation release the retry loop early. */
export const waitForRetryBackoff = async(delay: number, signal?: AbortSignal): Promise<void> => {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (signal?.aborted) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const finish = (): void => {
			if (timer) {
				clearTimeout(timer)
			}
			signal?.removeEventListener('abort', finish)
			resolve()
		}
		timer = setTimeout(finish, delay)
		// A caller awaiting flush/shutdown owns this bounded retry. Unref-ing the
		// only remaining handle lets Node terminate with an unsettled top-level
		// await before the retry can run (exit code 13).
		signal?.addEventListener('abort', finish, {once: true})
	})
}
