export function captureSingleFlightCallback(
	callback: (...args: never[]) => unknown
): (...args: never[]) => unknown {
	let active = 0
	let calls = 0
	let pending = 0
	return (...args: never[]) => {
		if (!active) calls = 0
		if (pending || calls++ >= 100) return undefined
		active++
		let result: unknown
		try { result = Reflect.apply(callback, undefined, args) } finally { active-- }
		pending++
		const release = (): void => { pending-- }
		try { void Reflect.apply(Promise.prototype.then, result, [release, release]) } catch { release() }
		return result
	}
}
