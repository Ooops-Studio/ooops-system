import {createAsyncContextStore} from '@ooopsstudio/core/runtime/context/als'

export interface TransferLifecycleReentryState {
	readonly linkedActive?: () => boolean
}

interface TransferLifecycleReentryScope {
	readonly state: TransferLifecycleReentryState
	active: boolean
}

const transferLifecycleStates = new WeakMap<object, TransferLifecycleReentryState>()
const transferLifecycleContext = createAsyncContextStore<readonly TransferLifecycleReentryScope[]>()

export const createTransferLifecycleReentryState = (
	linkedActive?: () => boolean
): TransferLifecycleReentryState => linkedActive ? {linkedActive} : {}

export const attachTransferLifecycleReentryState = <T extends object>(
	handle: T,
	state: TransferLifecycleReentryState
): T => {
	transferLifecycleStates.set(handle, state)
	return handle
}

export const getTransferLifecycleReentryState = (handle: object): TransferLifecycleReentryState | undefined =>
	transferLifecycleStates.get(handle)

export const isTransferLifecycleStateReentry = (state: TransferLifecycleReentryState): boolean =>
	transferLifecycleContext.get()?.some((scope) => scope.active && scope.state === state) === true
	|| state.linkedActive?.() === true

export const isTransferLifecycleReentry = (handle: object): boolean => {
	const state = transferLifecycleStates.get(handle)
	return !!state && isTransferLifecycleStateReentry(state)
}

export const invokeTransferLifecycle = async<T>(
	state: TransferLifecycleReentryState,
	callback: () => T
): Promise<Awaited<T>> => {
	const scope: TransferLifecycleReentryScope = {state, active: true}
	try {
		return await transferLifecycleContext.run([
			...(transferLifecycleContext.get() ?? []), scope
		], callback) as Awaited<T>
	} finally {
		scope.active = false
	}
}
