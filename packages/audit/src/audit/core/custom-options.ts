import {AUDIT_FLUSH_TIMEOUT_MS, AUDIT_MAXIMUM_LIMITS, AUDIT_SHUTDOWN_TIMEOUT_MS} from '../constants'
import type {AuditRedactionRule, AuditSafetyLimits} from '../types/store'
import {isAuditSafeString} from '../utils/string-safety'

function snapshotSafeRegExp(value: RegExp): RegExp {
	if (Object.getPrototypeOf(value) !== RegExp.prototype) throw new Error()
	if (Reflect.ownKeys(value).some((key) => key !== 'lastIndex')) throw new Error()
	const source = value.source
	if (source.length > 256 || /\\(?:[1-9]|k<)/u.test(source)
		|| /\(\?(?:[=!]|<[=!])/u.test(source)) throw new Error()
	let inClass = false
	let escaped = false
	let quantifiers = 0
	let unbounded = 0
	let hasAlternation = false
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!
		if (escaped) { escaped = false; continue }
		if (character === '\\') { escaped = true; continue }
		if (character === '[') { inClass = true; continue }
		if (character === ']' && inClass) { inClass = false; continue }
		if (inClass) continue
		if (character === '|') hasAlternation = true
		if (character === ')' && /^[+*?{]/u.test(source.slice(index + 1))) throw new Error()
		if (character === '*' || character === '+' || (character === '?' && source[index - 1] !== '(')) {
			quantifiers += 1
			if (character !== '?') unbounded += 1
		} else if (character === '{') {
			const repetition = /^\{(\d+)(,\d*)?\}/u.exec(source.slice(index))
			if (repetition) {
				quantifiers += 1
				if (repetition[2]?.endsWith(',')) unbounded += 1
				index += repetition[0].length - 1
			}
		}
	}
	if (inClass || escaped || quantifiers > 8 || unbounded > 1 || (hasAlternation && quantifiers > 0)) throw new Error()
	return new RegExp(source, value.flags)
}

export function resolveAuditLimits(value: Partial<AuditSafetyLimits> | undefined): AuditSafetyLimits {
	const result: Record<keyof AuditSafetyLimits, number> = {...AUDIT_MAXIMUM_LIMITS}
	if (value !== undefined) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audit safety limits must be an object.')
		try {
			if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error()
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key !== 'string' || !Object.hasOwn(AUDIT_MAXIMUM_LIMITS, key)) throw new Error()
				const descriptor = Object.getOwnPropertyDescriptor(value, key)
				if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
				result[key as keyof AuditSafetyLimits] = descriptor.value as number
			}
		} catch { throw new Error('Audit safety limits must contain only readable known fields.') }
	}
	for (const key of Object.keys(AUDIT_MAXIMUM_LIMITS) as Array<keyof AuditSafetyLimits>) {
		const minimum = key === 'maxStringLength' ? 512 : 1
		if (!Number.isInteger(result[key]) || result[key] < minimum || result[key] > AUDIT_MAXIMUM_LIMITS[key]) {
			throw new Error(`Audit safety limit ${key} must be between ${minimum} and ${AUDIT_MAXIMUM_LIMITS[key]}.`)
		}
	}
	return result as AuditSafetyLimits
}

export function snapshotAuditRedactionRules(
	value: ReadonlyArray<AuditRedactionRule> | undefined,
	limits: AuditSafetyLimits = AUDIT_MAXIMUM_LIMITS
): ReadonlyArray<AuditRedactionRule> {
	if (value === undefined) return []
	if (!Array.isArray(value)) throw new Error('Audit redactionRules must be a bounded array.')
	let length: number
	try {
		length = Object.getOwnPropertyDescriptor(value, 'length')?.value as number
		if (!Number.isSafeInteger(length) || length < 0 || length > 100) throw new Error()
		const arrayKeys = new Set(['length', ...Array.from({length}, (_, index) => String(index))])
		if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !arrayKeys.has(key))) throw new Error()
	} catch { throw new Error('Audit redactionRules must be a readable dense array.') }
	return Array.from({length}, (_, index) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
		if (!descriptor?.enumerable || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object' || Array.isArray(descriptor.value)) throw new Error(`Audit redaction rule ${index} is invalid.`)
		const rule: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const key of Reflect.ownKeys(descriptor.value)) {
			if (typeof key !== 'string' || !['path', 'key', 'action'].includes(key)) throw new Error(`Audit redaction rule ${index} contains an unknown field.`)
			const field = Object.getOwnPropertyDescriptor(descriptor.value, key)
			if (!field?.enumerable || !('value' in field)) throw new Error(`Audit redaction rule ${index} must contain only readable fields.`)
			rule[key] = field.value
		}
		const hasPath = rule.path !== undefined
		const hasKey = rule.key !== undefined
		let path: readonly (string | number)[] | undefined
		if (hasPath) {
			try {
				if (!Array.isArray(rule.path)) throw new Error()
				const length = Object.getOwnPropertyDescriptor(rule.path, 'length')?.value
				if (!Number.isSafeInteger(length) || length < 1 || length > limits.maxDepth + 1) throw new Error()
				const allowed = new Set(['length', ...Array.from({length}, (_, pathIndex) => String(pathIndex))])
				if (Reflect.ownKeys(rule.path).some((pathKey) => typeof pathKey !== 'string' || !allowed.has(pathKey))) throw new Error()
				const segments = Array.from({length}, (_, pathIndex) => {
					const segment = Object.getOwnPropertyDescriptor(rule.path as object, String(pathIndex))
					if (!segment?.enumerable || !('value' in segment)) throw new Error()
					return segment.value as unknown
				})
				path = Object.freeze(segments.map((segment) => {
					if (typeof segment === 'number') {
						if (!Number.isSafeInteger(segment) || segment < 0) throw new Error()
						return segment
					}
					if (typeof segment !== 'string' || !segment || segment.length > 256 || !isAuditSafeString(segment)) throw new Error()
					return segment
				}))
			} catch { throw new Error(`Audit redaction rule ${index} is invalid.`) }
		}
		let key: string | RegExp | undefined
		if (hasKey) {
			if (typeof rule.key === 'string') {
				if (!rule.key || rule.key.length > 256 || !isAuditSafeString(rule.key)) throw new Error(`Audit redaction rule ${index} is invalid.`)
				key = rule.key
			} else if (rule.key instanceof RegExp) {
				try { key = snapshotSafeRegExp(rule.key) } catch { throw new Error(`Audit redaction rule ${index} is invalid.`) }
			}
			else throw new Error(`Audit redaction rule ${index} is invalid.`)
		}
		if (hasPath === hasKey || !['mask', 'drop', 'hash'].includes(rule.action as string)) {
			throw new Error(`Audit redaction rule ${index} is invalid.`)
		}
		return Object.freeze({...(path ? {path} : {key: key!}), action: rule.action}) as AuditRedactionRule
	})
}

export function resolveAuditTimeouts(flushTimeoutMs?: number, shutdownTimeoutMs?: number) {
	const flush = flushTimeoutMs ?? AUDIT_FLUSH_TIMEOUT_MS
	const shutdown = shutdownTimeoutMs ?? AUDIT_SHUTDOWN_TIMEOUT_MS
	const maximum = 2_147_483_647
	if (!Number.isSafeInteger(flush) || flush <= 0 || flush > maximum
		|| !Number.isSafeInteger(shutdown) || shutdown <= 0 || shutdown > maximum) {
		throw new Error(`Audit finalization timeouts must be safe integers between 1 and ${maximum}.`)
	}
	return {flushTimeoutMs: flush, shutdownTimeoutMs: shutdown}
}
