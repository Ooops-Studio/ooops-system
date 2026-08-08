const randomHex = (): string | undefined => {
	try {
		const bytes = new Uint8Array(16)
		globalThis.crypto?.getRandomValues?.(bytes)
		if (bytes.some((byte) => byte !== 0)) {
			return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
		}
	} catch {
		// Fall through to the non-cryptographic diagnostic identifier.
	}
	return undefined
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function generateErrorId(): string | undefined {
	try {
		const id: unknown = globalThis.crypto?.randomUUID?.()
		if (typeof id === 'string' && CANONICAL_UUID.test(id)) return id
	} catch {
		// Try the remaining runtime-neutral fallbacks.
	}
	const hex = randomHex()
	if (hex) return hex
	try {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	} catch {
		return undefined
	}
}
