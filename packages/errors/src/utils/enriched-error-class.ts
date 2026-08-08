/**
 * @file EnrichedError class that extends Error and preserves all enriched metadata.
 * Used when rethrowing errors to preserve debugging trace fidelity.
 */

import type {EnrichedError as EnrichedErrorInterface} from '@ooopsstudio/core/contracts/errors'

/**
 * EnrichedError class that extends Error and preserves all enriched metadata.
 * Ensures debugging trace fidelity by preserving stack, cause, and all enriched fields.
 */
export class EnrichedError extends Error implements EnrichedErrorInterface {
	readonly kind: string
	readonly severity: EnrichedErrorInterface['severity']
	readonly category: EnrichedErrorInterface['category']
	readonly timestamp: number
	readonly id?: string
	readonly correlationId?: string
	readonly traceId?: string
	readonly source?: string
	readonly context?: Readonly<Record<string, unknown>>
	readonly code?: string
	readonly data?: Readonly<Record<string, unknown>>
	override readonly cause?: unknown

	constructor(enriched: EnrichedErrorInterface) {
		super(enriched.message)

		// Preserve original stack if available
		if (enriched.stack) {
			this.stack = enriched.stack
		}

		// Preserve original cause
		this.cause = enriched.cause

		// Copy all enriched fields
		this.kind = enriched.kind
		this.severity = enriched.severity
		this.category = enriched.category
		this.timestamp = enriched.timestamp
		if (enriched.id !== undefined) {
			this.id = enriched.id
		}
		if (enriched.correlationId !== undefined) {
			this.correlationId = enriched.correlationId
		}
		if (enriched.traceId !== undefined) {
			this.traceId = enriched.traceId
		}
		if (enriched.source !== undefined) {
			this.source = enriched.source
		}
		if (enriched.context !== undefined) {
			this.context = enriched.context
		}
		if (enriched.code !== undefined) {
			this.code = enriched.code
		}
		if (enriched.data !== undefined) {
			this.data = enriched.data
		}

		// Set error name to match kind
		this.name = enriched.kind
	}
}
