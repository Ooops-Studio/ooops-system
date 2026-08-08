export function throwFinalizationFailures(failures: readonly unknown[], message: string): void {
	if (failures.length === 0) return
	if (failures.length === 1) throw new Error(message)
	throw new AggregateError(
		failures.map(() => new Error('Errors finalization component failed.')),
		message
	)
}

export async function collectFinalizationFailures(
	actions: ReadonlyArray<(() => void | Promise<void>) | undefined>
): Promise<unknown[]> {
	const results = await Promise.allSettled(
		actions.filter((action): action is () => void | Promise<void> => action !== undefined)
			.map(async(action) => await action())
	)
	return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
}
