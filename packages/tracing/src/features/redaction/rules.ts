import {snapshotDataFields} from '../../utils/capabilities'

import type {TraceRedactionRule} from './types'

const RULE_FIELDS = new Set(['key', 'action', 'maxBytes'])

export function snapshotTraceRedactionRules(rules: unknown): ReadonlyArray<TraceRedactionRule> {
	if (!Array.isArray(rules)) throw new Error('Tracing redaction rules must contain at most 1000 entries')
	const length = Object.getOwnPropertyDescriptor(rules, 'length')?.value as unknown
	if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > 1_000) {
		throw new Error('Tracing redaction rules must contain at most 1000 entries')
	}
	const safeRules: TraceRedactionRule[] = []
	let regularExpressionRules = 0
	for (let index = 0; index < (length as number); index++) {
		const descriptor = Object.getOwnPropertyDescriptor(rules, String(index))
		if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Tracing redaction rules must be a dense data array')
		let values: Readonly<Record<string, unknown>>
		try { values = snapshotDataFields(descriptor.value, 3, 64, RULE_FIELDS) } catch {
			throw new TypeError(`Tracing redaction rule ${index} must be a closed plain data object`)
		}
		const {key, action, maxBytes} = values
		if (action !== 'mask' && action !== 'drop' && action !== 'truncate') throw new Error(`Invalid tracing redaction action at rule ${index}`)
		if (typeof key !== 'string' && (!key || typeof key !== 'object')) throw new Error(`Invalid tracing redaction key at rule ${index}`)
		if (action === 'truncate') {
			if (!Number.isInteger(maxBytes) || (maxBytes as number) <= 0 || (maxBytes as number) > 8_192) {
				throw new Error(`Tracing redaction maxBytes at rule ${index} must be between 1 and 8192`)
			}
		} else if (maxBytes !== undefined) throw new Error(`Tracing redaction maxBytes is only valid for truncate at rule ${index}`)
		const safeKey = typeof key === 'string' ? snapshotRuleKey(key, index) : cloneRegExp(key, index)
		if (safeKey instanceof RegExp && ++regularExpressionRules > 64) {
			throw new Error('Tracing redaction rules must contain at most 64 regular-expression keys')
		}
		safeRules.push(Object.freeze(action === 'truncate'
			? {key: safeKey, action, maxBytes: maxBytes as number}
			: {key: safeKey, action}))
	}
	return Object.freeze(safeRules)
}

function cloneRegExp(value: object, index: number): RegExp {
	let source: string
	let flags: string
	try {
		const readNative = (property: string): unknown => {
			const getter = Object.getOwnPropertyDescriptor(RegExp.prototype, property)?.get
			return getter ? Reflect.apply(getter, value, []) : undefined
		}
		const nativeSource = readNative('source')
		if (typeof nativeSource !== 'string') throw new TypeError()
		source = nativeSource
		flags = [
			['hasIndices', 'd'], ['global', 'g'], ['ignoreCase', 'i'], ['multiline', 'm'],
			['dotAll', 's'], ['unicode', 'u'], ['unicodeSets', 'v'], ['sticky', 'y']
		].map(([property, flag]) => readNative(property!) === true ? flag : '').join('')
	} catch { throw new Error(`Invalid tracing redaction key at rule ${index}`) }
	validateLinearRegExpSource(source, index)
	return new RegExp(source, flags.replace(/[gy]/gu, ''))
}

function snapshotRuleKey(value: string, index: number): string {
	if (value.length === 0 || value.length > 256) {
		throw new Error(`Tracing redaction string key at rule ${index} must contain 1-256 characters`)
	}
	return value
}

function validateLinearRegExpSource(source: string, index: number): void {
	if (source.length === 0 || source.length > 256) {
		throw new Error(`Tracing redaction RegExp at rule ${index} must contain 1-256 characters`)
	}
	let escaped = false
	let inCharacterClass = false
	for (const character of source) {
		if (escaped) { escaped = false; continue }
		if (character === '\\') { escaped = true; continue }
		if (character === '[') { inCharacterClass = true; continue }
		if (character === ']' && inCharacterClass) { inCharacterClass = false; continue }
		if (!inCharacterClass && (character === '*' || character === '+' || character === '?' || character === '{')) {
			throw new Error(`Tracing redaction RegExp at rule ${index} must not contain repetition or lookaround constructs`)
		}
	}
	if (escaped || inCharacterClass || /\\(?:[1-9]|k<)/u.test(source)) {
		throw new Error(`Tracing redaction RegExp at rule ${index} is not a bounded key matcher`)
	}
}
