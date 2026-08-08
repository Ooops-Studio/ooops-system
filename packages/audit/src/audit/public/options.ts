export function snapshotAuditPresetOptions(
	value: unknown,
	allowedFields: ReadonlySet<string>,
	label: string
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} options are invalid.`)
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || !allowedFields.has(key)) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			result[key] = descriptor.value
		}
	} catch { throw new Error(`${label} options must contain only readable known fields.`) }
	return result
}

export function snapshotAuditResource(value: ObservabilityResource | undefined): ObservabilityResource | undefined {
	if (value === undefined) return undefined
	const resource = normalizeCorrelation({resource: value}, [], AUDIT_MAXIMUM_LIMITS, false).resource
	if (!resource) throw new Error('Audit resource is invalid.')
	return Object.freeze(resource)
}
import type {ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'

import {AUDIT_MAXIMUM_LIMITS} from '../constants'
import {normalizeCorrelation} from '../core/normalization'
