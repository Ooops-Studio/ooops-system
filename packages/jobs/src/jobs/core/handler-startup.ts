const INITIAL_TICK_MAX_ATTEMPTS = 3
const INITIAL_TICK_RETRY_DELAYS_MS = [100, 250] as const

const TRANSIENT_ERROR_CODES = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'EPIPE',
	'ETIMEDOUT',
	'ENETDOWN',
	'ENETRESET',
	'ENETUNREACH',
	'EHOSTDOWN',
	'EHOSTUNREACH',
	'57P01',
	'57P02',
	'57P03',
	'40001',
	'40P01'
])

const TRANSIENT_MESSAGE_FRAGMENTS = [
	'connection terminated unexpectedly',
	'connection reset',
	'connection refused',
	'connection closed',
	'connection lost',
	'database system is starting up',
	'database system is shutting down',
	'terminating connection due to administrator command',
	'operation timed out',
	'query timed out',
	'connect timeout',
	'connection timeout',
	'socket hang up'
] as const

function dataProperty(value: object, key: PropertyKey): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	} catch { return undefined }
}

function transientLeaf(error: unknown, depth: number): boolean {
	if (depth >= 8 || !error || typeof error !== 'object') return false
	const aggregate = dataProperty(error, 'errors')
	if (Array.isArray(aggregate)) {
		const failures = aggregate.slice(0, 16)
		return failures.length > 0 && failures.every((failure) => transientLeaf(failure, depth + 1))
	}
	const code = dataProperty(error, 'code')
	if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code.toUpperCase())) return true
	const message = dataProperty(error, 'message')
	if (typeof message === 'string') {
		const normalized = message.toLowerCase()
		if (TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true
	}
	const cause = dataProperty(error, 'cause')
	return cause === undefined ? false : transientLeaf(cause, depth + 1)
}

export function isTransientJobsStartupError(error: unknown): boolean {
	return transientLeaf(error, 0)
}

const delay = async(ms: number): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function runInitialJobsTickWithRetry(
	tick: () => Promise<void>,
	onRetry: (input: {attempt: number; nextAttempt: number; delayMs: number}) => void
): Promise<void> {
	for (let attempt = 1; attempt <= INITIAL_TICK_MAX_ATTEMPTS; attempt += 1) {
		try {
			await tick()
			return
		} catch(error) {
			if (attempt >= INITIAL_TICK_MAX_ATTEMPTS || !isTransientJobsStartupError(error)) throw error
			const delayMs = INITIAL_TICK_RETRY_DELAYS_MS[attempt - 1] ?? 250
			onRetry({attempt, nextAttempt: attempt + 1, delayMs})
			await delay(delayMs)
		}
	}
}
