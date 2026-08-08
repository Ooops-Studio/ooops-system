/**
 * @file Error classification based on registry.
 * Uses explicit classification rules table for clarity and testability.
 */

import {CLASSIFICATION_RULES, DEFAULT_ERROR_CATEGORIES} from '../../constants'
import type {ErrorClassificationRegistry} from '../../types/error-handler'
import type {EnrichedError, ErrorCategory, ErrorSeverity} from '../../types/normalized-error'
import {ERROR_CATEGORIES} from '../../utils/error-values'
import {deriveRedactedError, redactEnrichedError} from '../../utils/redaction'

const PUBLIC_KIND_PATTERNS = new WeakMap<ReadonlyArray<string>, ReadonlySet<string>>()
const PUBLIC_CODE_PATTERNS = new WeakMap<ReadonlyArray<string>, ReadonlySet<string>>()
const VALIDATED_REGISTRY_SNAPSHOTS = new WeakMap<object, ErrorClassificationRegistry>()
const MACHINE_WORD_END = /[\p{L}\p{M}\p{N}]$/u
const MACHINE_WORD_START = /^[\p{L}\p{M}\p{N}]/u

function publicMachinePattern(pattern: string, field: 'kind' | 'code'): string | undefined {
	const projected = redactEnrichedError({
		kind: field === 'kind' ? pattern : 'Error',
		message: 'classification pattern',
		...(field === 'code' ? {code: pattern} : {}),
		severity: 'error', category: 'UNKNOWN', timestamp: 0
	})
	return field === 'kind' ? projected.kind : projected.code
}

function registerPublicPatternFingerprints(patterns: ReadonlyArray<string>): void {
	PUBLIC_KIND_PATTERNS.set(patterns, new Set(patterns.flatMap((pattern) => {
		const projected = publicMachinePattern(pattern, 'kind')
		return projected === undefined ? [] : [projected]
	})))
	PUBLIC_CODE_PATTERNS.set(patterns, new Set(patterns.flatMap((pattern) => {
		const projected = publicMachinePattern(pattern, 'code')
		return projected === undefined ? [] : [projected]
	})))
}

function getSafeRegistryEntries(
	registry: ErrorClassificationRegistry
): Array<[ErrorCategory, ReadonlyArray<string>]> {
	try {
		return Reflect.ownKeys(registry).slice(0, 64).flatMap((category) => {
			if (typeof category !== 'string' || !ERROR_CATEGORIES.includes(category as ErrorCategory)) return []
			const descriptor = Object.getOwnPropertyDescriptor(registry, category)
			const patterns = descriptor && 'value' in descriptor ? descriptor.value : undefined
			return Array.isArray(patterns)
				? [[category as ErrorCategory, patterns] as [ErrorCategory, ReadonlyArray<string>]]
				: []
		})
	} catch {
		return []
	}
}

function safePatternLength(patterns: ReadonlyArray<string>): number | undefined {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(patterns, 'length')
		const length = descriptor && 'value' in descriptor ? descriptor.value : undefined
		return Number.isSafeInteger(length) && length >= 0 ? length : undefined
	} catch {
		return undefined
	}
}

/** Strict descriptor-only validation for long-lived factory configuration. */
export function isValidClassificationRegistryConfiguration(
	registry: ErrorClassificationRegistry
): boolean {
	try {
		VALIDATED_REGISTRY_SNAPSHOTS.delete(registry)
		const prototype = Object.getPrototypeOf(registry)
		if (prototype !== Object.prototype && prototype !== null) return false
		const keys = Reflect.ownKeys(registry)
		if (keys.length > 64) return false
		const snapshot = Object.create(null) as Record<string, ReadonlyArray<string>>
		for (const category of keys) {
			if (typeof category !== 'string' || !ERROR_CATEGORIES.includes(category as ErrorCategory)) return false
			const descriptor = Object.getOwnPropertyDescriptor(registry, category)
			if (!descriptor?.enumerable || !('value' in descriptor) || !Array.isArray(descriptor.value)) return false
			const patterns = descriptor.value as unknown[]
			if (Object.getPrototypeOf(patterns) !== Array.prototype) return false
			const lengthDescriptor = Object.getOwnPropertyDescriptor(patterns, 'length')
			const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
			if (!Number.isSafeInteger(length) || length < 0 || length > 100) return false
			const allowed = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
			if (Reflect.ownKeys(patterns).some((key) => typeof key !== 'string' || !allowed.has(key))) return false
			const copied: string[] = []
			for (let index = 0; index < length; index += 1) {
				const pattern = Object.getOwnPropertyDescriptor(patterns, String(index))
				if (!pattern?.enumerable || !('value' in pattern) || typeof pattern.value !== 'string'
					|| pattern.value.length === 0 || pattern.value.length > 128) return false
				copied.push(pattern.value)
			}
			const frozen = Object.freeze(copied)
			registerPublicPatternFingerprints(frozen)
			snapshot[category] = frozen
		}
		VALIDATED_REGISTRY_SNAPSHOTS.set(registry, Object.freeze(snapshot))
		return true
	} catch {
		return false
	}
}

/**
 * Take a descriptor-only copy of caller-owned classification configuration.
 * Handler factories are long-lived; retaining the input arrays made their
 * behaviour change when a caller mutated configuration after construction.
 */
export function snapshotClassificationRegistry(
	registry: ErrorClassificationRegistry
): ErrorClassificationRegistry {
	const validated = VALIDATED_REGISTRY_SNAPSHOTS.get(registry)
	if (validated) return validated
	const snapshot: Record<string, ReadonlyArray<string>> = Object.create(null) as Record<string, ReadonlyArray<string>>
	for (const [category, patterns] of getSafeRegistryEntries(registry)) {
		const copied: string[] = []
		try {
			const length = safePatternLength(patterns) ?? 0
			for (let index = 0; index < Math.min(length, 100); index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(patterns, String(index))
				const pattern = descriptor && 'value' in descriptor ? descriptor.value : undefined
				if (typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 128) copied.push(pattern)
			}
		} catch {
			// Keep the valid prefix already copied from a hostile pattern array.
		}
		const frozen = Object.freeze(copied)
		registerPublicPatternFingerprints(frozen)
		snapshot[category] = frozen
	}
	return Object.freeze(snapshot)
}

const DEFAULT_REGISTRY = snapshotClassificationRegistry(DEFAULT_ERROR_CATEGORIES)
const SEVERITY_OVERRIDES = new Map(CLASSIFICATION_RULES.map((rule) => [
	rule.category,
	Object.freeze({...rule.severityOverride})
] as const))

function matchesPattern(patterns: ReadonlyArray<string>, value: string, exact: boolean): boolean {
	try {
		const publicPatterns = exact ? PUBLIC_KIND_PATTERNS.get(patterns) : PUBLIC_CODE_PATTERNS.get(patterns)
		if (publicPatterns?.has(value)) return true
		const length = safePatternLength(patterns)
		if (length === undefined) return false
		for (let index = 0; index < Math.min(length, 100); index++) {
			const descriptor = Object.getOwnPropertyDescriptor(patterns, String(index))
			const pattern = descriptor && 'value' in descriptor ? descriptor.value : undefined
			if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 128) continue
			if (exact ? value === pattern : matchesCodeToken(value, pattern)) return true
		}
		return false
	} catch {
		return false
	}
}

function matchesCodeToken(value: string, pattern: string): boolean {
	let start = value.indexOf(pattern)
	while (start >= 0) {
		// Slice at the token boundary so Unicode mode observes a complete code point;
		// indexing one UTF-16 code unit misclassified astral letters as separators.
		const leftBoundary = start === 0 || !MACHINE_WORD_END.test(value.slice(0, start))
		const end = start + pattern.length
		const rightBoundary = end === value.length || !MACHINE_WORD_START.test(value.slice(end))
		if (leftBoundary && rightBoundary) return true
		start = value.indexOf(pattern, start + 1)
	}
	return false
}

function dataString(value: object, key: string): string | undefined {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
			&& descriptor.value.length <= 1_024
			? descriptor.value
			: undefined
	} catch {
		return undefined
	}
}

/**
 * Classify an error based on its kind/code using a registry
 * @param error - The error to classify
 * @param registry - Optional custom classification registry
 * @returns Classified error with category and adjusted severity
 */
export function classifyError(
	error: EnrichedError,
	registry: ErrorClassificationRegistry = DEFAULT_REGISTRY
): EnrichedError {
	// Classification is internal and must happen before public redaction. Error
	// kinds such as TokenExpiredError are machine identifiers, not credentials;
	// hashing them first made caller-supplied registries impossible to honor.
	const classificationKind = error && typeof error === 'object'
		? dataString(error, 'kind')
		: undefined
	const classificationCode = error && typeof error === 'object'
		? dataString(error, 'code')
		: undefined
	const safeError = redactEnrichedError(error)
	let category: ErrorCategory = safeError.category ?? 'UNKNOWN'
	let severity: ErrorSeverity = safeError.severity
	const registryEntries = getSafeRegistryEntries(registry)

	if (category === 'UNKNOWN') {
		// Try to match error kind first
		for (const [candidateCategory, patterns] of registryEntries) {
			if (matchesPattern(patterns, classificationKind ?? safeError.kind, true)) {
				category = candidateCategory
				break
			}
		}

		// If not found by kind, try error code
		const code = classificationCode ?? safeError.code
		if (category === 'UNKNOWN' && code) {
			for (const [candidateCategory, patterns] of registryEntries) {
				if (matchesPattern(patterns, code, false)) {
					category = candidateCategory
					break
				}
			}
		}
	}

	// Apply severity overrides from explicit classification rules
	// Find matching rule for the category
	const severityOverride = SEVERITY_OVERRIDES.get(category)
	if (severityOverride) {
		const override = severityOverride[severity]
		if (override) {
			severity = override
		}
	}

	// Fallback: unclassified errors (UNKNOWN category) default to ERROR severity
	// This ensures all unclassified errors are visible and actionable
	if (category === 'UNKNOWN' && severity === 'info') {
		severity = 'error'
	}

	return deriveRedactedError(safeError, {category, severity})
}
