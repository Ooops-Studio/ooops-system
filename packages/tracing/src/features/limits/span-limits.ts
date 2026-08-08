/**
 * @file Span limits configuration.
 * Encapsulates limit configuration for span attributes, events, and bytes.
 */
import {snapshotDataFields} from '../../utils/capabilities'
import {validateLimits} from '../../utils/config-validation'
/**
 * Options for creating span limits.
 */
export interface SpanLimitsOptions {
	/** Maximum attributes per span */
	maxAttributesPerSpan?: number
	/** Maximum events per span */
	maxEventsPerSpan?: number
	/** Maximum attribute bytes per span */
	maxAttrBytes?: number
}
/**
 * Span limits configuration.
 * Encapsulates limit values and provides validation.
 */
export class SpanLimits {
	/** Maximum attributes per span */
	readonly maxAttributesPerSpan: number
	/** Maximum events per span */
	readonly maxEventsPerSpan: number
	/** Maximum attribute bytes per span */
	readonly maxAttrBytes: number
	constructor(options: SpanLimitsOptions = {}) {
		let configured: Readonly<Record<string, unknown>>
		try {
			configured = snapshotDataFields(options, 3, 32, new Set([
				'maxAttributesPerSpan', 'maxEventsPerSpan', 'maxAttrBytes'
			]))
		} catch { throw new TypeError('Tracing span limit options must be a closed plain data object') }
		const {
			maxAttributesPerSpan = 64,
			maxEventsPerSpan = 32,
			maxAttrBytes = 4_000
		} = configured as SpanLimitsOptions
		// Validate limits
		validateLimits({
			maxAttributesPerSpan,
			maxEventsPerSpan,
			maxAttrBytes
		})
		this.maxAttributesPerSpan = maxAttributesPerSpan as number
		this.maxEventsPerSpan = maxEventsPerSpan as number
		this.maxAttrBytes = maxAttrBytes as number
	}
	/**
	 * Get limits as a plain object.
	 */
	toObject(): {
		maxAttributesPerSpan: number
		maxEventsPerSpan: number
		maxAttrBytes: number
	} {
		return {
			maxAttributesPerSpan: this.maxAttributesPerSpan,
			maxEventsPerSpan: this.maxEventsPerSpan,
			maxAttrBytes: this.maxAttrBytes
		}
	}
}
/**
 * Create span limits instance.
 */
export function createSpanLimits(options?: SpanLimitsOptions): SpanLimits {
	return new SpanLimits(options)
}
