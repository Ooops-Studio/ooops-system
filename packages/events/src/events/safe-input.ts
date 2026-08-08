import {isolateUnexpectedThenable, snapshotBoundedDataGraph} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

/** Attach rejection observers to known synchronous option fields before validation can short-circuit. */
export function isolateInputFields(owner: unknown, keys: readonly string[]): void {
	isolateUnexpectedThenable(owner)
	if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null) return
	for (const key of keys) {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key)
			if (descriptor && 'value' in descriptor) isolateUnexpectedThenable(descriptor.value)
		} catch(error) { isolateUnexpectedThenable(error) }
	}
}

/** Observe every known method slot before capability validation can stop at the first invalid method. */
export function isolateCapabilityFields(owner: unknown, required: readonly string[], optional: readonly string[] = []): void {
	isolateInputFields(owner, [...required, ...optional])
}

/** Observe known fields on every bounded array item without invoking array or item accessors. */
export function isolateArrayItemFields(owner: unknown, keys: readonly string[], maximum = 256): void {
	isolateUnexpectedThenable(owner)
	if (!Array.isArray(owner)) return
	try {
		const descriptor = Object.getOwnPropertyDescriptor(owner, 'length')
		const length = descriptor && 'value' in descriptor ? descriptor.value : 0
		if (!Number.isSafeInteger(length) || length < 0) return
		for (let index = 0; index < Math.min(length, maximum); index++) {
			const item = Object.getOwnPropertyDescriptor(owner, String(index))
			if (item && 'value' in item) isolateInputFields(item.value, keys)
		}
	} catch(error) { isolateUnexpectedThenable(error) }
}

/** Observe the complete, bounded events backend capability surface before validating any one branch. */
export function isolateEventsBackendInput(owner: unknown): void {
	const capabilities = {
		outbox: [['append', 'claimDue', 'renew', 'complete', 'retry', 'deadLetter', 'purgeExpired', 'queuedCount'], ['flush', 'shutdown']],
		inbox: [['claim', 'renew', 'complete', 'release'], ['flush', 'shutdown']],
		transactional: [['appendTransactional'], []],
		admin: [['replay', 'retryDeadLetter', 'cancelScheduled', 'listOutbox', 'listDeadLetters', 'purgeExpired'], []],
		compatibility: [['check'], []]
	} as const
	isolateInputFields(owner, ['durability', ...Object.keys(capabilities)])
	if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null) return
	for (const [name, [required, optional]] of Object.entries(capabilities)) {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(owner, name)
			if (descriptor && 'value' in descriptor) isolateCapabilityFields(descriptor.value, required, optional)
		} catch(error) { isolateUnexpectedThenable(error) }
	}
}

export function inputField(owner: unknown, key: string, code: string): unknown {
	try {
		if ((typeof owner !== 'object' && typeof owner !== 'function') || owner === null) throw new Error(code)
		if (isolateUnexpectedThenable(owner)) throw new Error(code)
		const descriptor = Object.getOwnPropertyDescriptor(owner, key)
		if (!descriptor) return undefined
		if (!('value' in descriptor)) throw new Error(code)
		if (isolateUnexpectedThenable(descriptor.value)) throw new Error(code)
		return descriptor.value
	} catch(error) { isolateUnexpectedThenable(error); throw new Error(code) }
}

export function inputList(value: unknown, maximum: number, code: string): readonly unknown[] {
	let snapshot: unknown
	try { snapshot = snapshotBoundedDataGraph(value) } catch(error) { isolateUnexpectedThenable(error); throw new Error(code) }
	if (!Array.isArray(snapshot) || !snapshot.length || snapshot.length > maximum) throw new Error(code)
	return Object.freeze(snapshot)
}
