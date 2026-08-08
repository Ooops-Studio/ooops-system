export interface CacheMutationCoordinator {
	run<T>(keys: readonly string[] | undefined, operation: () => Promise<T>): Promise<T>
	wait(keys: readonly string[]): Promise<void>
	isPending(key: string): boolean
}

export const MAX_TRACKED_CACHE_MUTATION_KEYS = 10_000

/**
 * Preserve acceptance order for overlapping mutations without serializing
 * unrelated cache keys. A broad mutation waits for every accepted key mutation
 * and also becomes a barrier for mutations accepted after it.
 */
export function createCacheMutationCoordinator(onCapacityExceeded?: () => void): CacheMutationCoordinator {
	const keyTails = new Map<string, Promise<unknown>>()
	let broadTail: Promise<unknown> | undefined
	const dependenciesFor = (keys?: readonly string[]): Set<Promise<unknown>> => {
		const dependencies = new Set<Promise<unknown>>()
		if (broadTail) dependencies.add(broadTail)
		if (keys === undefined) for (const tail of keyTails.values()) dependencies.add(tail)
		else for (const key of keys) {
			const tail = keyTails.get(key)
			if (tail) dependencies.add(tail)
		}
		return dependencies
	}

	return {
		isPending(key: string): boolean {
			return !!broadTail || keyTails.has(key)
		},
		async wait(keys: readonly string[]): Promise<void> {
			await Promise.allSettled(dependenciesFor(keys))
		},
		run<T>(keys: readonly string[] | undefined, operation: () => Promise<T>): Promise<T> {
			const selectedKeys = keys === undefined ? undefined : [...new Set(keys)]
			if (selectedKeys !== undefined) {
				let additions = 0
				for (const key of selectedKeys) if (!keyTails.has(key)) additions++
				if (keyTails.size + additions > MAX_TRACKED_CACHE_MUTATION_KEYS) {
					onCapacityExceeded?.()
					throw new Error('CACHE_MUTATION_CAPACITY')
				}
			}
			const work = Promise.allSettled(dependenciesFor(selectedKeys)).then(operation)
			if (selectedKeys === undefined) broadTail = work
			else for (const key of selectedKeys) keyTails.set(key, work)

			const cleanup = (): void => {
				if (selectedKeys === undefined) {
					if (broadTail === work) broadTail = undefined
					return
				}
				for (const key of selectedKeys) if (keyTails.get(key) === work) keyTails.delete(key)
			}
			void work.then(cleanup, cleanup)
			return work
		}
	}
}
