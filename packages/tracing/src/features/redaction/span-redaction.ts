/**
 * @file Span attribute redaction.
 * Applies mandatory built-in protection plus optional tracing-local rules.
 */
import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'

import {snapshotSpanAttributesDetailed} from '../../core/span-recorder-safety'
import {snapshotDataFields} from '../../utils/capabilities'
import {createTracingOnError} from '../../utils/on-error'

import {snapshotTraceRedactionRules} from './rules'
import type {TraceRedactionRule} from './types'
/**
 * Options for span redaction.
 */
export interface SpanRedactionOptions {
	/** Additional tracing-local rules. Built-in redaction cannot be disabled. */
	rules?: ReadonlyArray<TraceRedactionRule>
	/** Optional error handler */
	errors?: Errors
}
const MAX_REDACTION_FIELDS = 400
const MAX_REDACTION_SNAPSHOT_BYTES = 16 * 1_024 * 1_024

function snapshotRedactionAttributes(value: LogAttributes): LogAttributes | undefined {
	const snapshot = snapshotSpanAttributesDetailed(value, MAX_REDACTION_FIELDS, MAX_REDACTION_SNAPSHOT_BYTES)
	return snapshot.droppedCount === 0 ? snapshot.attributes : undefined
}

export function maskAttributes(attrs: LogAttributes): LogAttributes {
	const masked: Record<string, JsonValue> = {}
	const snapshot = snapshotRedactionAttributes(attrs)
	if (!snapshot) return masked
	for (const key of Object.keys(snapshot)) masked[key] = '***'
	return masked
}
/**
 * Create a span attribute redaction function.
 * @param options - Redaction options
 * @returns Redaction function
 */
export function createSpanRedaction(options: SpanRedactionOptions = {}): (attrs: LogAttributes) => LogAttributes {
	const configured = snapshotRedactionOptions(options)
	const safeRules = snapshotTraceRedactionRules(configured.rules ?? [])
	const matcher = compileRules(safeRules)
	const errors = configured.errors as Errors | undefined
	const reportError = createTracingOnError(errors, {stage: 'tracing'})
	return (attrs: LogAttributes): LogAttributes => {
		try {
			const snapshot = snapshotRedactionAttributes(attrs)
			if (!snapshot) throw new TypeError('Tracing redaction attributes are unsafe or oversized')
			return sanitizeAttributes(snapshot, matcher)
		} catch(error) {
			reportError(error, {operation: 'redact'})
			return maskAttributes(attrs)
		}
	}
}

function snapshotRedactionOptions(options: unknown): Readonly<{rules?: unknown; errors?: unknown}> {
	return snapshotPlainData(options, new Set(['rules', 'errors']), 'Tracing redaction options')
}

function snapshotPlainData(value: unknown, allowed: ReadonlySet<string>, label: string): Readonly<Record<string, unknown>> {
	try {
		return snapshotDataFields(value, allowed.size, 64, allowed)
	} catch {
		throw new TypeError(`${label} must be a closed plain data object`)
	}
}

const sensitiveKey = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|session(?:[-_]?id)?|email|phone|ssn|credit[-_]?card|card[-_]?number)/iu
const sensitiveText = /(?:https?:\/\/[^\s?#]+(?:\?[^\s#]*|#[^\s]*)|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:bearer|basic)\s+[\w./+=-]+|\b(?:api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[A-Za-z0-9+/_-]{32,}={0,2}\b)/giu

interface CompiledRule {readonly rule: TraceRedactionRule; readonly index: number}
interface CompiledRules {
	readonly exact: ReadonlyMap<string, CompiledRule>
	readonly patterns: readonly CompiledRule[]
}

function compileRules(rules: ReadonlyArray<TraceRedactionRule>): CompiledRules {
	const exact = new Map<string, CompiledRule>()
	const patterns: CompiledRule[] = []
	for (const [index, rule] of rules.entries()) {
		const compiled = {rule, index}
		if (typeof rule.key === 'string') {
			const normalized = normalizeKey(rule.key)
			if (!exact.has(normalized)) exact.set(normalized, compiled)
		} else patterns.push(compiled)
	}
	return Object.freeze({exact, patterns: Object.freeze(patterns)})
}

function sanitizeValue(value: JsonValue, rules: CompiledRules, depth = 0): JsonValue {
	if (typeof value === 'string') return value.replace(sensitiveText, '[REDACTED]')
	if (depth >= 8) return '[Truncated]'
	if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeValue(entry, rules, depth + 1))
	if (value && typeof value === 'object') {
		if (!isPlainObject(value)) return '[Truncated]'
		const output: Record<string, JsonValue> = {}
		for (const [key, entry] of Object.entries(value).slice(0, 100)) {
			if (isDangerousKey(key)) continue
			const rule = getRule(key, rules)
			if (rule?.action === 'drop') continue
			output[key] = sensitiveKey.test(key) || rule?.action === 'mask'
				? '***'
				: rule?.action === 'truncate' ? truncateValue(entry, rule.maxBytes) : sanitizeValue(entry, rules, depth + 1)
		}
		return output
	}
	return value
}

function sanitizeAttributes(attrs: LogAttributes, rules: CompiledRules): LogAttributes {
	if (!isPlainObject(attrs)) throw new TypeError('Tracing redaction attributes must be a plain data object')
	const output: Record<string, JsonValue> = {}
	for (const [key, value] of Object.entries(attrs)) {
		if (isDangerousKey(key)) continue
		const rule = getRule(key, rules)
		if (rule?.action === 'drop') continue
		output[key] = sensitiveKey.test(key) || rule?.action === 'mask'
			? '***'
			: rule?.action === 'truncate' ? truncateValue(value, rule.maxBytes) : sanitizeValue(value, rules)
	}
	return output as LogAttributes
}

function getRule(key: string, rules: CompiledRules): TraceRedactionRule | undefined {
	const normalizedKey = normalizeKey(key)
	let selected = rules.exact.get(normalizedKey)
	for (const candidate of rules.patterns) {
		if (selected && candidate.index > selected.index) break
		const pattern = candidate.rule.key as RegExp
		pattern.lastIndex = 0
		if (pattern.test(key)) { selected = candidate; break }
	}
	return selected?.rule
}

function truncateValue(value: JsonValue, maxBytes: number): JsonValue {
	if (typeof value !== 'string') return '[Truncated]'
	const encoder = new TextEncoder()
	if (encoder.encode(value).byteLength <= maxBytes) return value
	const suffix = '[Truncated]'
	const suffixBytes = encoder.encode(suffix).byteLength
	const boundedSuffix = suffixBytes <= maxBytes ? suffix : suffix.slice(0, maxBytes)
	const contentBudget = Math.max(0, maxBytes - Math.min(suffixBytes, maxBytes))
	let output = ''
	let outputBytes = 0
	for (const character of value) {
		const characterBytes = utf8CodePointBytes(character)
		if (outputBytes + characterBytes > contentBudget) break
		output += character
		outputBytes += characterBytes
	}
	return `${output}${boundedSuffix}`
}

function utf8CodePointBytes(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0
	if (codePoint <= 0x7f) return 1
	if (codePoint <= 0x7ff) return 2
	if (codePoint <= 0xffff) return 3
	return 4
}

function normalizeKey(key: string): string { return key.toLowerCase().replace(/[\s_.-]/gu, '') }
function isDangerousKey(key: string): boolean { return key === '__proto__' || key === 'prototype' || key === 'constructor' }
