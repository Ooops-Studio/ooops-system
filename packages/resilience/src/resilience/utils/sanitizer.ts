import {createHash} from 'node:crypto'

import type {ResilienceExecutionContext as ResilienceOperationContext} from '@ooopsstudio/core/contracts/resilience'

import {getPlainDataDescriptors} from './data-object'

const MAX_SAFE_SEGMENT_LENGTH = 64
const MAX_FINGERPRINT_INPUT_LENGTH = 4_096
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const LONG_HEX_PATTERN = /\b[0-9a-f]{16,}\b/gi
const NUMERIC_SEGMENT_PATTERN = /(^|[/:])\d+(?=$|[/:])/g
const UNSAFE_CHARS_PATTERN = /[^a-zA-Z0-9._:-]+/g
const IDENTIFIER_LIKE_RESOURCE_PATTERN = /(?:^|[._:-])(?:tenant|workspace|user|account|customer|organization|org)(?:[._:-]|$)/iu

function safeString(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return `${value}`
	if (value === null || value === undefined) return ''
	return '[unavailable]'

}

export function fingerprintResilienceValue(value: unknown): string {
	const raw = safeString(value)
	const input = raw.length > MAX_FINGERPRINT_INPUT_LENGTH
		? `${raw.slice(0, MAX_FINGERPRINT_INPUT_LENGTH / 2)}:${raw.length}:${raw.slice(-MAX_FINGERPRINT_INPUT_LENGTH / 2)}`
		: raw
	let hash = 0xcbf29ce484222325n
	const prime = 0x100000001b3n
	const mask = 0xffffffffffffffffn

	for (let index = 0; index < input.length; index++) {
		hash ^= BigInt(input.charCodeAt(index))
		hash = (hash * prime) & mask
	}

	return `fp_${hash.toString(16).padStart(16, '0')}`
}

/** Collision-resistant fingerprint for bounded internal state identity, never observability cardinality. */
export function fingerprintResilienceIdentity(value: string): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
		throw new Error('[Resilience] invalid state identity')
	}
	return `fp_${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

export function sanitizeResilienceResource(resource: string | undefined): string {
	if (!resource) {
		return 'unknown'
	}
	if (resource.length > MAX_SAFE_SEGMENT_LENGTH) return fingerprintResilienceValue(resource)

	if (URL.canParse(resource) || /[/?#@]/u.test(resource)) {
		return fingerprintResilienceValue(resource)
	}

	const candidate = resource
		.replace(UUID_PATTERN, ':id')
		.replace(LONG_HEX_PATTERN, ':id')
		.replace(NUMERIC_SEGMENT_PATTERN, '$1:id')
		.replace(UNSAFE_CHARS_PATTERN, '.')
		.replace(/\.{2,}/g, '.')
		.replace(/^\.|\.$/g, '')

	if (!candidate || candidate.length > MAX_SAFE_SEGMENT_LENGTH || IDENTIFIER_LIKE_RESOURCE_PATTERN.test(candidate)) {
		return fingerprintResilienceValue(resource)
	}

	return candidate
}

/** Sanitize a developer-defined operation label without treating ordinary nouns as resource identifiers. */
export function sanitizeResilienceOperationName(operation: string | undefined): string {
	if (!operation) return 'unknown'
	if (operation.length > MAX_SAFE_SEGMENT_LENGTH) return fingerprintResilienceValue(operation)
	if (/[/?#@]/u.test(operation)) return fingerprintResilienceValue(operation)

	const candidate = operation
		.replace(UNSAFE_CHARS_PATTERN, '.')
		.replace(/\.{2,}/g, '.')
		.replace(/^\.|\.$/g, '')

	return candidate && candidate.length <= MAX_SAFE_SEGMENT_LENGTH
		? candidate
		: fingerprintResilienceValue(operation)
}

export function sanitizeResilienceContext(
	context: ResilienceOperationContext
): ResilienceOperationContext {
	const contextDescriptors = getPlainDataDescriptors(context, 6)
	const read = (key: string): unknown => contextDescriptors?.[key]?.value
	let metadata: Record<string, string | number | boolean> | undefined
	const rawMetadata = read('metadata')
	if (rawMetadata) {
		const descriptors = getPlainDataDescriptors(rawMetadata, 32)
		if (descriptors) {
			metadata = Object.create(null) as Record<string, string | number | boolean>
			for (const [key, descriptor] of Object.entries(descriptors)) {
				const value = descriptor.value
				metadata[fingerprintResilienceValue(key)] = typeof value === 'string'
					? fingerprintResilienceValue(value)
					: typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'
						? value as number | boolean
						: '[unavailable]'
			}
		} else {
			metadata = {metadata: '[unavailable]'}
		}
	}

	const sanitized: {-readonly [Key in keyof ResilienceOperationContext]: ResilienceOperationContext[Key]} = {
		resource: sanitizeResilienceResource(typeof read('resource') === 'string' ? read('resource') as string : undefined)
	}
	for (const key of ['tenantId', 'workspaceId', 'userId', 'correlationId'] as const) {
		const value = read(key)
		if (typeof value === 'string' && value) sanitized[key] = fingerprintResilienceValue(value)
	}
	if (metadata && Object.keys(metadata).length > 0) sanitized.metadata = metadata
	return sanitized
}

export function sanitizeResilienceKeyPart(value: string): string {
	return fingerprintResilienceValue(value)
}

function ownString(value: object, key: string): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined
}

export function describeResilienceError(error: unknown): {type: string; message: string} {
	if (error && typeof error === 'object') try {
		let prototype = Object.getPrototypeOf(error) as object | null
		for (let depth = 32; prototype && depth--; prototype = Object.getPrototypeOf(prototype) as object | null) {
			if (prototype !== Error.prototype) continue
			const name = ownString(error, 'name')
			const message = ownString(error, 'message')
			return {
				type: name ? name.slice(0, 128) : 'Error',
				message: message?.slice(0, 1_024) ?? '[unavailable]'
			}
		}
	} catch { return {type: 'Error', message: '[unavailable]'} }
	return {type: typeof error, message: safeString(error).slice(0, 1_024)}

}

const SAFE_RESILIENCE_ERROR_TYPES = new Set([
	'Error',
	'TimedOutError',
	'BreakerOpenError',
	'BulkheadOverflowError',
	'RetryExhaustedError',
	'ResilienceConfigurationError'
])

export function sanitizeResilienceErrorType(type: string): string {

	return SAFE_RESILIENCE_ERROR_TYPES.has(type) ? type : 'ResilienceOperationError'

}
