export function markDeliveredLines(
	lines: readonly string[],
	markDelivered: (line: string) => void
): void {
	for (const line of lines) {
		markDelivered(line)
	}
}

export function throwIfCleanupFailed(errors: unknown[], message: string): void {
	if (errors.length === 0) {
		return
	}
	if (errors.length === 1) {
		throw errors[0]
	}
	throw new AggregateError(errors, message)
}
