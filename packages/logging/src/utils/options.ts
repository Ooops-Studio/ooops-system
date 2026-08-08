import {snapshotDenseDataArray, snapshotPlainDataRecord} from '@ooopsstudio/core/utils/validation'

import type {EnrichingProvider} from '../types/enriching'

export function snapshotLoggingOptions<T>(
	value: unknown,
	allowedFields: readonly string[],
	label: string
): T {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} options must be an object`)
	}
	const snapshot = snapshotPlainDataRecord(value, new Set(allowedFields))
	if (!snapshot) throw new TypeError(`${label} options contain invalid or unexpected fields`)
	return snapshot as T
}

export function snapshotEnrichingProviders(value: unknown): readonly EnrichingProvider[] {
	if (value === undefined) return []
	const snapshot = snapshotDenseDataArray(value, 100)
	if (!snapshot || snapshot.some((provider) => typeof provider !== 'function')) {
		throw new TypeError('Logging providers must be a dense array of at most 100 functions')
	}
	return snapshot as EnrichingProvider[]
}
