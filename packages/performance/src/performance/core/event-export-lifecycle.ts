type ExporterLifecycleHook = 'flush' | 'shutdown'

export interface EventExporterLifecycleOperations {
	run(
		name: string,
		hookName: ExporterLifecycleHook,
		hook: () => void | Promise<void>
	): Promise<void>
}

/** Reuses pending hooks and remembers late success after an external timeout. */
export function createEventExporterLifecycleOperations(): EventExporterLifecycleOperations {
	const completed = new Set<string>()
	const pending = new Map<string, Promise<void>>()
	return {
		run(name, hookName, hook) {
			const key = `${hookName}:${name}`
			if (completed.has(key)) return Promise.resolve()
			const existing = pending.get(key)
			if (existing) return existing
			const operation = Promise.resolve().then(async() => await hook())
			pending.set(key, operation)
			void operation.then(
				() => {
					completed.add(key)
					pending.delete(key)
				},
				() => pending.delete(key)
			)
			return operation
		}
	}
}
