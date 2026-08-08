/** Takes a stable, accessor-free snapshot of optional adapter configuration. */
export const snapshotAdapterOptions = <TOptions extends object>(
	value: TOptions | undefined,
	keys: readonly (keyof TOptions)[]
): TOptions => {
	const snapshot: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>
	if (!value || typeof value !== 'object') return snapshot as TOptions
	try {
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (descriptor?.enumerable && 'value' in descriptor) snapshot[key] = descriptor.value
		}
	} catch {
		// Optional instrumentation configuration fails open.
	}
	return snapshot as TOptions
}
