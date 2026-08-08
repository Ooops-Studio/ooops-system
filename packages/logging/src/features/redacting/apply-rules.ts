/**
 * @file Rule application helpers for Redacting.
 * Applies rules to `record.context.attributes` without exceptions.
 */

import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import {hasSensitiveKeyObfuscation, sensitiveKeyContainsPayload} from '../../core/redacting-utilities'
import type {RedactingRule, RedactingBudgets, RedactingPolicy} from '../../types/redacting'
import {inspectLoggingProperty, isPlainLoggingObject} from '../../utils/capabilities'
import {createStageOnError} from '../../utils/on-error'

import {
	DEFAULT_ARRAY_LENGTH,
	DEFAULT_BYTES,
	DEFAULT_DEPTH,
	DEFAULT_OBJECT_ENTRIES,
	hashValueFailClosed,
	isObjectLike,
	MASK_SYMBOL,
	maskAttributesFailClosed,
	normalizeRedactionBudget,
	normalizeKey,
	sizeof,
	testPattern,
	truncateUtf8
} from './apply-rules-internals'

type NormalizedBudgets = Required<Pick<
	RedactingBudgets,
	'maxDepth' | 'maxStringBytes' | 'maxArrayLength' | 'maxObjectEntries'
>>

const MAX_TRAVERSAL_NODES = 10_000
const MAX_OUTPUT_KEY_LENGTH = 256

interface RedactionTraversalState {
	bytes: number
	remainingNodes: number
	readonly seen: WeakSet<object>
}

interface RedactionResult {
	readonly value: unknown
	readonly changed: boolean
	readonly drop?: boolean
}

function normalizeBudgets(budgets?: RedactingBudgets): NormalizedBudgets {
	return {
		maxDepth: normalizeRedactionBudget(budgets?.maxDepth, DEFAULT_DEPTH),
		maxStringBytes: normalizeRedactionBudget(budgets?.maxStringBytes, DEFAULT_BYTES),
		maxArrayLength: normalizeRedactionBudget(budgets?.maxArrayLength, DEFAULT_ARRAY_LENGTH),
		maxObjectEntries: normalizeRedactionBudget(budgets?.maxObjectEntries, DEFAULT_OBJECT_ENTRIES)
	}
}

function pathString(path: readonly string[]): string {
	return path.join('.')
}

function matchesRedactKey(policy: RedactingPolicy, key: string): boolean {
	if (hasSensitiveKeyObfuscation(key)) return true
	return (policy.redactKeys ?? []).some((pattern) => {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (typeof pattern === 'string') return normalizeKey(pattern) === normalizeKey(key)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return testPattern(pattern, key) || testPattern(pattern, normalizeKey(key))
	})
}

function matchesValuePattern(policy: RedactingPolicy, value: unknown): boolean {
	return typeof value === 'string' && (policy.redactValuePatterns ?? []).some((pattern) => testPattern(pattern, value))
}

function outputKey(
	policy: RedactingPolicy,
	key: string,
	index: number,
	out: Readonly<Record<string, unknown>>
): string {
	if (key.length <= MAX_OUTPUT_KEY_LENGTH && !matchesValuePattern(policy, key)
		&& !sensitiveKeyContainsPayload(key)) return key
	let candidate = `__redacted_key_${index}__`
	let collision = 0
	while (Object.prototype.hasOwnProperty.call(out, candidate)) {
		collision += 1
		candidate = `__redacted_key_${index}_${collision}__`
	}
	return candidate
}

function ruleMatches(rule: RedactingRule, path: readonly string[], key?: string): boolean {
	if (rule.key !== undefined) {
		const currentKey = key ?? path[path.length - 1] ?? ''
		return typeof rule.key === 'string'
			? normalizeKey(rule.key) === normalizeKey(currentKey)
			: testPattern(rule.key, currentKey) || testPattern(rule.key, normalizeKey(currentKey))
	}
	return pathString(rule.path.map(String)) === pathString(path)
}

function findDirectRule(
	rules: ReadonlyArray<RedactingRule> | undefined,
	path: readonly string[],
	key?: string
): RedactingRule | undefined {
	if (!rules) return undefined
	for (let index = rules.length - 1; index >= 0; index -= 1) {
		const rule = rules[index] as RedactingRule
		if (ruleMatches(rule, path, key)) return rule
	}
	return undefined
}

function applyRuleToValue(value: unknown, rule: RedactingRule, arrayItem = false): RedactionResult {
	switch (rule.action) {
		case 'drop':
			return arrayItem ? {value: null, changed: true} : {value: undefined, changed: true, drop: true}
		case 'mask':
			return {value: MASK_SYMBOL, changed: true}
		case 'hash':
			return {value: hashValueFailClosed(value), changed: true}
		case 'truncate': {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			const maxLength = normalizeRedactionBudget(rule.maxBytes, 0)
			if (typeof value === 'string' && maxLength > 0) {
				const truncated = truncateUtf8(value, maxLength)
				if (truncated !== value) return {value: `${truncated}…`, changed: true}
			}
			return {value, changed: false}
		}
		default:
			return {value, changed: false}
	}
}

function redactValue(
	value: unknown,
	policy: RedactingPolicy,
	budgets: NormalizedBudgets,
	path: readonly string[],
	depth: number,
	state: RedactionTraversalState,
	key?: string,
	arrayItem = false
): RedactionResult {
	if (key) {
		state.bytes += sizeof(key)
		if (state.bytes > budgets.maxStringBytes) return {value: MASK_SYMBOL, changed: true}
		if (key.length > MAX_OUTPUT_KEY_LENGTH) return {value: MASK_SYMBOL, changed: true}
	}
	if (typeof value === 'string') {
		state.bytes += sizeof(value)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (state.bytes > budgets.maxStringBytes) return {value: MASK_SYMBOL, changed: true}
	}

	const sensitive = (key !== undefined && (matchesRedactKey(policy, key) || matchesValuePattern(policy, key))) ||
		matchesValuePattern(policy, value)
	const directRule = findDirectRule(policy.rules, path, key)
	if (directRule) {
		if (sensitive && directRule.action !== 'mask' && directRule.action !== 'drop') {
			return {value: MASK_SYMBOL, changed: true}
		}
		const result = applyRuleToValue(value, directRule, arrayItem)
		// A truncate rule only applies to strings. A non-string value still has
		// to cross the structural redaction boundary below.
		if (result.changed || result.drop || typeof value === 'string') return result
	}

	if (sensitive) {
		return {value: MASK_SYMBOL, changed: true}
	}
	if (typeof value === 'function' || typeof value === 'symbol') {
		return {value: MASK_SYMBOL, changed: true}
	}

	if (!isObjectLike(value)) {
		return {value, changed: false}
	}

	if (state.remainingNodes <= 0) return {value: MASK_SYMBOL, changed: true}
	state.remainingNodes -= 1

	if (depth >= budgets.maxDepth) {
		// Traversal limits are fail-closed: retaining an uninspected object could
		// expose a secret below the limit boundary.
		return {value: MASK_SYMBOL, changed: true}
	}
	if (state.seen.has(value)) return {value: MASK_SYMBOL, changed: true}
	state.seen.add(value)

	if (Array.isArray(value)) {
		const next: unknown[] = []
		const inspectedLength = inspectLoggingProperty<unknown>(value, 'length')
		if (!inspectedLength.safe || !Number.isSafeInteger(inspectedLength.value) || (inspectedLength.value as number) < 0) {
			throw new TypeError('Logging redaction could not safely inspect an array')
		}
		const length = inspectedLength.value as number
		const readableLength = Math.min(length, budgets.maxArrayLength)
		for (let index = 0; index < readableLength; index += 1) {
			const inspected = inspectLoggingProperty<unknown>(value, String(index))
			if (!inspected.safe) throw new TypeError('Logging redaction rejected an accessor-backed array item')
			const result = redactValue(inspected.value, policy, budgets, [...path, String(index)], depth + 1, state, String(index), true)
			next.push(result.value)
		}
		if (length > budgets.maxArrayLength) {
			next.push(MASK_SYMBOL)
		}
		return {value: next, changed: true}
	}
	if (!isPlainLoggingObject(value)) return {value: MASK_SYMBOL, changed: true}

	const keys = Object.keys(value)
	const next = Object.create(null) as Record<string, unknown>
	for (const [index, entryKey] of keys.slice(0, budgets.maxObjectEntries).entries()) {
		const inspected = inspectLoggingProperty<unknown>(value, entryKey)
		if (!inspected.safe) throw new TypeError('Logging redaction rejected an accessor-backed property')
		const result = redactValue(inspected.value, policy, budgets, [...path, entryKey], depth + 1, state, entryKey)
		if (!result.drop) {
			next[outputKey(policy, entryKey, index, next)] = result.value
		}
	}
	if (keys.length > budgets.maxObjectEntries) {
		next.__truncated__ = MASK_SYMBOL
	}
	return {value: next, changed: true}
}

/** Apply a list of rules safely and return a detached structural snapshot. */
export function applyRulesSafe(
	attrs: LogAttributes | undefined,
	rules: ReadonlyArray<RedactingRule>,
	budgets?: RedactingBudgets,
	errors?: Errors
): LogAttributes | undefined {
	return applyPolicySafe(attrs, {rules}, budgets, errors)
}

export function applyPolicySafe(
	attrs: LogAttributes | undefined,
	policy: RedactingPolicy,
	budgets?: RedactingBudgets,
	errors?: Errors
): LogAttributes | undefined {
	const hasPolicy = (policy.rules?.length ?? 0) > 0 ||
		(policy.redactKeys?.length ?? 0) > 0 ||
		(policy.redactValuePatterns?.length ?? 0) > 0
	if (!attrs || !hasPolicy) return attrs
	const normalizedBudgets = normalizeBudgets(budgets)
	try {
		const result = redactValue(attrs, policy, normalizedBudgets, [], 0, {
			bytes: 0,
			remainingNodes: MAX_TRAVERSAL_NODES,
			seen: new WeakSet<object>()
		})
		return result.changed ? result.value as LogAttributes : attrs
	} catch(error) {
		const onError = createStageOnError(errors, {
			stage: 'redacting',
			step: 'apply-policy'
		})
		onError(error)
	}
	return maskAttributesFailClosed(attrs)
}
