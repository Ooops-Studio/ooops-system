export type MemoryStorageBucket = 'runs' | 'schedules' | 'deadLetters' | 'idempotency'

export interface MemoryStorageBudget {
	totalBytes: number
	sizes: Record<MemoryStorageBucket, Map<string, number>>
}

export interface MemoryStorageChange {
	bucket: MemoryStorageBucket
	key: string
	value?: unknown
	remove?: boolean
}

export const MAX_MEMORY_JOBS_BYTES = 64 * 1024 * 1024

export function createMemoryStorageBudget(): MemoryStorageBudget {
	return {
		totalBytes: 0,
		sizes: {
			runs: new Map(), schedules: new Map(), deadLetters: new Map(), idempotency: new Map()
		}
	}
}

export function cloneMemoryStorageBudget(budget: MemoryStorageBudget): MemoryStorageBudget {
	return {
		totalBytes: budget.totalBytes,
		sizes: {
			runs: new Map(budget.sizes.runs),
			schedules: new Map(budget.sizes.schedules),
			deadLetters: new Map(budget.sizes.deadLetters),
			idempotency: new Map(budget.sizes.idempotency)
		}
	}
}

function serializedBytes(value: unknown): number {
	const encoded = JSON.stringify(value)
	if (encoded === undefined) throw new Error('Memory jobs record is not serializable')
	return Buffer.byteLength(encoded)
}

/** Reserve all record changes together before mutating their corresponding maps. */
export function tryCommitMemoryStorageBudget(
	budget: MemoryStorageBudget,
	changes: readonly MemoryStorageChange[]
): boolean {
	const identities = new Set<string>()
	const prepared = changes.map((change) => {
		const identity = `${change.bucket}\0${change.key}`
		if (identities.has(identity)) throw new Error('Memory jobs storage change contains duplicate records')
		identities.add(identity)
		const previous = budget.sizes[change.bucket].get(change.key) ?? 0
		const next = change.remove ? 0 : serializedBytes(change.value)
		return {...change, previous, next}
	})
	const nextTotal = prepared.reduce(
		(total, change) => total - change.previous + change.next,
		budget.totalBytes
	)
	if (!Number.isSafeInteger(nextTotal) || nextTotal < 0 || nextTotal > MAX_MEMORY_JOBS_BYTES) {
		return false
	}
	for (const change of prepared) {
		if (change.remove) budget.sizes[change.bucket].delete(change.key)
		else budget.sizes[change.bucket].set(change.key, change.next)
	}
	budget.totalBytes = nextTotal
	return true

}

export function commitMemoryStorageBudget(
	budget: MemoryStorageBudget,
	changes: readonly MemoryStorageChange[]
): void {
	if (!tryCommitMemoryStorageBudget(budget, changes)) {
		throw new Error('Memory jobs serialized storage capacity exceeded')
	}
}
