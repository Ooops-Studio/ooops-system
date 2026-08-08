interface PatternFrame {
	hasAlternation: boolean
	hasRepetition: boolean
}

const unsafe = (): never => {
	throw new TypeError('Custom logging redaction RegExp must be linear-time safe')
}

function assertSafeRedactionPattern(source: string, flags: string): void {
	if (source.length > 256) unsafe()
	const frames: PatternFrame[] = [{hasAlternation: false, hasRepetition: false}]
	let inCharacterClass = false
	let unboundedRepetitions = 0
	let variableRepetitions = 0
	let requiresStartAnchor = false
	let hasTopLevelAlternation = false
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]
		if (character === '\\') {
			const escaped = source[index + 1]
			if (escaped && (/[1-9]/u.test(escaped) || escaped === 'k')) unsafe()
			index += 1
			continue
		}
		if (character === '[') { inCharacterClass = true; continue }
		if (character === ']' && inCharacterClass) { inCharacterClass = false; continue }
		if (inCharacterClass) continue
		const current = frames[frames.length - 1] as PatternFrame
		if (character === '(') {
			if (source[index + 1] === '?' && source[index + 2] !== ':') unsafe()
			frames.push({hasAlternation: false, hasRepetition: false})
			if (source[index + 1] === '?') index += 2
			continue
		}
		if (character === '|') {
			current.hasAlternation = true
			if (frames.length === 1) hasTopLevelAlternation = true
			continue
		}
		if (character === ')') {
			const completed = frames.pop() ?? unsafe()
			if (frames.length === 0) unsafe()
			const next = source[index + 1]
			if ((next === '*' || next === '+' || next === '?' || next === '{') &&
				(completed.hasAlternation || completed.hasRepetition)) unsafe()
			const parent = frames[frames.length - 1] as PatternFrame
			parent.hasAlternation ||= completed.hasAlternation
			parent.hasRepetition ||= completed.hasRepetition
			continue
		}
		if (character === '*' || character === '+' || character === '?' || character === '{') {
			current.hasRepetition = true
			const closingBrace = character === '{' ? source.indexOf('}', index + 1) : -1
			let operands: string[] = []
			if (closingBrace > index) {
				operands = source.slice(index + 1, closingBrace).match(/\d+/gu) ?? []
				if (operands.some((operand) => Number(operand) > 1_000)) unsafe()
			}
			const unbounded = character === '*' || character === '+' || (character === '{' && (
				closingBrace < 0 || /^\d+,\s*$/u.test(source.slice(index + 1, closingBrace))
			))
			if (unbounded && ++unboundedRepetitions > 1) unsafe()
			const braceVariable = character === '{' && (
				closingBrace < 0 || operands.length !== 1 || source.slice(index + 1, closingBrace).includes(',')
			)
			if (character === '*' || character === '+' || character === '?' || braceVariable) {
				variableRepetitions += 1
				if (variableRepetitions > 1) unsafe()
			}
			if (character === '*' || character === '+' || (character === '{' && operands.some(
				(operand) => Number(operand) > 1
			))) requiresStartAnchor = true
		}
	}
	if (frames.length !== 1 || inCharacterClass) unsafe()
	if (requiresStartAnchor && (!source.startsWith('^') && !flags.includes('y'))) unsafe()
	if (requiresStartAnchor && hasTopLevelAlternation) unsafe()
}

export function cloneSafeRedactionPattern(pattern: RegExp): RegExp {
	const source = pattern.source
	const flags = pattern.flags
	const snapshot = new RegExp(source, flags)
	assertSafeRedactionPattern(snapshot.source, snapshot.flags)
	return snapshot
}
