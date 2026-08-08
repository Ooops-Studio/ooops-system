type RuntimeUtilModule = {
	types?: {isProxy?: (value: unknown) => boolean}
}

type RuntimeProcess = {
	getBuiltinModule?: (specifier: string) => unknown
}

const runtimeUtil = (() => {
	try {
		return (globalThis as {process?: RuntimeProcess}).process
			?.getBuiltinModule?.('node:util') as RuntimeUtilModule | undefined
	} catch { return undefined }
})()

/**
 * Uses Node's trap-free native Proxy detector when the host exposes a safe
 * synchronous builtin lookup. Browser runtimes deliberately fall back to
 * guarded reflection instead of importing a Node builtin into client bundles.
 */
export const isRuntimeProxy = (value: unknown): boolean => {
	try { return !!runtimeUtil?.types?.isProxy?.(value) } catch { return false }
}
