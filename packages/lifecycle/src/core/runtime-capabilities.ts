const cleanupCapabilities = new WeakMap<object, (cleanup: () => void) => () => void>()

export function registerLifecycleCleanupCapability(
	runtime: object,
	attach: (cleanup: () => void) => () => void
): void {
	cleanupCapabilities.set(runtime, attach)
}

export function unregisterLifecycleCleanupCapability(runtime: object): void {
	cleanupCapabilities.delete(runtime)
}

export function attachLifecycleCleanup(
	runtime: object,
	cleanup: () => void
): (() => void) | undefined {
	return cleanupCapabilities.get(runtime)?.(cleanup)
}
