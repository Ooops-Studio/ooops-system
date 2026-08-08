const MAX_RUNTIME_REFLECTION_DEPTH = 100
let activeRuntimeReflections = 0
let runtimeReflectionCalls = 0

/** Bounds hostile Proxy re-entry when a native trap-free detector is unavailable. */
export function runBoundedRuntimeReflection<T>(callback: () => T): T {
	if (!activeRuntimeReflections) runtimeReflectionCalls = 0
	if (runtimeReflectionCalls++ >= MAX_RUNTIME_REFLECTION_DEPTH) {
		throw new TypeError()
	}
	activeRuntimeReflections += 1
	try { return callback() } finally { activeRuntimeReflections -= 1 }
}
