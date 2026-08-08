export const MAX_JOBS_COLLECTION_BYTES = 64 * 1024 * 1024

function encodedRecordBytes(value: unknown, label: string): number {
	const encoded = JSON.stringify(value)
	if (encoded === undefined) throw new Error(`Jobs ${label} contains non-serializable records`)
	return Buffer.byteLength(encoded)
}

export function addJobsCollectionRecordSize(total: number, value: unknown, label: string): number {
	const next = total + encodedRecordBytes(value, label)
	if (!Number.isSafeInteger(next) || next > MAX_JOBS_COLLECTION_BYTES) {
		throw new Error(`Jobs ${label} exceeds the provider result size limit`)
	}
	return next
}

/** Return the next collection size, or undefined when a valid record would exceed the batch budget. */
export function tryAddJobsCollectionRecordSize(total: number, value: unknown, label: string): number | undefined {
	const next = total + encodedRecordBytes(value, label)
	if (!Number.isSafeInteger(next)) throw new Error(`Jobs ${label} exceeds the provider result size limit`)
	return next > MAX_JOBS_COLLECTION_BYTES ? undefined : next
}

export function validateJobsCollectionSize(values: readonly unknown[], label: string): void {
	let total = 0
	for (const value of values) total = addJobsCollectionRecordSize(total, value, label)
}
