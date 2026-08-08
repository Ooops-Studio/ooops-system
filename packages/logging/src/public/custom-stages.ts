import {snapshotDenseDataArray, snapshotPlainDataRecord} from '@ooopsstudio/core/utils/validation'

import {createEnriching} from '../core/enriching'
import {createFormatting} from '../core/formatting'
import {createRedacting} from '../core/redacting'
import type {Enriching, EnrichingCustomOptions} from '../types/enriching'
import type {Formatting, FormattingMode} from '../types/formatting'
import type {Redacting, RedactingCustomOptions, RedactingRule} from '../types/redacting'
import {snapshotLogContext} from '../utils/enriching'
import {createEnrichingWithErrorHandling} from '../utils/enriching-factory'
import {snapshotEnrichingProviders, snapshotLoggingOptions} from '../utils/options'
import {mergeRedactingPolicies, SAFE_DEFAULT_REDACTING_POLICY} from '../utils/redaction-policy'
import {cloneSafeRedactionPattern} from '../utils/safe-regexp'

export async function createCustomEnriching(
	options: Readonly<EnrichingCustomOptions> = {}
): Promise<Enriching> {
	const snapshot = snapshotLoggingOptions<Readonly<EnrichingCustomOptions>>(options, [
		'clock', 'resource', 'context', 'providers', 'mutableLevel', 'sampling',
		'errors', 'selfMetrics', 'metrics', 'lifecycle'
	], 'Custom logging enriching')
	const context = snapshotLogContext(snapshot.context) ?? {}
	const providers = snapshotEnrichingProviders(snapshot.providers ?? [])
	const base = createEnriching(context, snapshot.errors)
	const dynamic = providers.length > 0
		? (await import('../features/enriching/dynamic-providers')).createDynamicProvidersEnriching(
			providers, snapshot.errors, snapshot.selfMetrics, snapshot.metrics
		) : undefined
	return createEnrichingWithErrorHandling(async(record, enrichingOptions) => {
		const enriched = await base(record, enrichingOptions)
		return dynamic ? await dynamic(enriched, enrichingOptions) : enriched
	}, {stage: 'enriching', step: 'custom'})
}

const cloneKey = (value: unknown): string | RegExp => {
	if (typeof value === 'string') return value
	if (value instanceof RegExp) return cloneSafeRedactionPattern(value)
	throw new TypeError('Custom logging redaction key must be a string or RegExp')
}

const snapshotRule = (value: unknown): RedactingRule => {
	const rule = snapshotPlainDataRecord(value, new Set(['key', 'path', 'action', 'maxBytes']), ['action'])
	if (!rule || !['mask', 'hash', 'drop', 'truncate'].includes(rule.action as string)) {
		throw new TypeError('Custom logging redaction rule is invalid')
	}
	const hasKey = rule.key !== undefined
	const hasPath = rule.path !== undefined
	if (hasKey === hasPath) throw new TypeError('Custom logging redaction rule requires exactly one key or path')
	const target = hasKey ? {key: cloneKey(rule.key)} : (() => {
		const path = snapshotDenseDataArray(rule.path, 64)
		if (!path || path.length === 0 || path.some((part) => typeof part !== 'string' && typeof part !== 'number')) {
			throw new TypeError('Custom logging redaction path must contain 1 to 64 string or number segments')
		}
		return {path}
	})()
	if (rule.action === 'truncate') {
		if (!Number.isSafeInteger(rule.maxBytes) || (rule.maxBytes as number) <= 0) {
			throw new TypeError('Custom logging truncate rules require a positive maxBytes')
		}
		return {...target, action: 'truncate', maxBytes: rule.maxBytes as number} as RedactingRule
	}
	if (rule.maxBytes !== undefined) throw new TypeError('Custom logging maxBytes is only valid for truncate rules')
	return {...target, action: rule.action} as RedactingRule
}

const snapshotArray = <T>(
	value: unknown,
	name: string,
	maximum: number,
	map: (entry: unknown) => T
): T[] | undefined => {
	if (value === undefined) return undefined
	const entries = snapshotDenseDataArray(value, maximum)
	if (!entries) throw new TypeError(`Custom logging ${name} must be a dense array of at most ${maximum} items`)
	return entries.map(map)
}

export async function createCustomRedacting(
	options: Readonly<RedactingCustomOptions> = {}
): Promise<Redacting> {
	const snapshot = snapshotLoggingOptions<Readonly<RedactingCustomOptions>>(options, [
		'additionalKeys', 'additionalValuePatterns', 'additionalRules', 'budgets', 'errors'
	], 'Custom logging redacting')
	const additionalKeys = snapshotArray(snapshot.additionalKeys, 'additionalKeys', 32, cloneKey)
	const additionalValuePatterns = snapshotArray(snapshot.additionalValuePatterns, 'additionalValuePatterns', 32, (entry) => {
		if (!(entry instanceof RegExp)) throw new TypeError('Custom logging value patterns must be RegExp values')
		return cloneSafeRedactionPattern(entry)
	})
	const additionalRules = snapshotArray(snapshot.additionalRules, 'additionalRules', 64, snapshotRule)
	const budgets = snapshot.budgets === undefined ? {} : snapshotLoggingOptions(snapshot.budgets, [
		'maxDepth', 'maxStringBytes', 'maxArrayLength', 'maxObjectEntries'
	], 'Custom logging redaction budgets') as Record<string, number | undefined>
	const cap = (value: number | undefined, fallback: number, maximum: number): number => {
		if (value === undefined) return fallback
		if (!Number.isFinite(value) || value < 0) throw new TypeError('Custom logging redaction budgets must be non-negative numbers')
		return Math.min(Math.floor(value), maximum)
	}
	return createRedacting({
		policy: mergeRedactingPolicies(SAFE_DEFAULT_REDACTING_POLICY, {
			...(additionalKeys ? {redactKeys: additionalKeys} : {}),
			...(additionalValuePatterns ? {redactValuePatterns: additionalValuePatterns} : {}),
			...(additionalRules ? {rules: additionalRules} : {})
		}),
		budgets: {
			maxDepth: cap(budgets.maxDepth, 8, 8),
			maxStringBytes: cap(budgets.maxStringBytes, 8_192, 8_192),
			maxArrayLength: cap(budgets.maxArrayLength, 1_000, 1_000),
			maxObjectEntries: cap(budgets.maxObjectEntries, 1_000, 1_000)
		},
		...(snapshot.errors ? {errors: snapshot.errors} : {})
	})
}

export async function createCustomFormatting(mode: FormattingMode): Promise<Formatting> {
	if (mode !== 'json' && mode !== 'pretty') throw new TypeError('Custom logging format must be json or pretty')
	const formatter = mode === 'json'
		? (await import('../features/formatting/json')).formatJson
		: (await import('../features/formatting/pretty')).formatPretty
	return createFormatting(formatter)
}
