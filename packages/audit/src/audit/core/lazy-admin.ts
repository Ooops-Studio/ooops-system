import type {AuditAdminPort} from '@ooopsstudio/core/ports/audit'

import type {AuditAdminOptions} from './admin'

type AuditAdminMethod = keyof AuditAdminPort

/**
 * Keeps compliance-only validation/export/pruning code out of the normal
 * record/query startup graph. Admission is tracked before the dynamic import,
 * so shutdown cannot overtake an admin call that has already been accepted.
 */
export function createLazyAuditAdmin(options: AuditAdminOptions): AuditAdminPort {
	let adminPromise: Promise<AuditAdminPort> | undefined
	const load = (): Promise<AuditAdminPort> => {
		if (adminPromise) return adminPromise
		const loading = import('./admin')
			.then(({createAuditAdmin}) => createAuditAdmin({
				...options,
				track: async<T>(operation: () => Promise<T>) => await operation()
			}))
			.catch(async(error: unknown) => {
				if (adminPromise === loading) adminPromise = undefined
				await options.observeFailure('admin_load', error)
				throw error
			})
		adminPromise = loading
		return loading
	}
	const invoke = async<K extends AuditAdminMethod>(
		method: K,
		...args: Parameters<AuditAdminPort[K]>
	): Promise<Awaited<ReturnType<AuditAdminPort[K]>>> => await options.track(async() => {
		const admin = await load()
		return await (admin[method] as (...values: Parameters<AuditAdminPort[K]>) => ReturnType<AuditAdminPort[K]>)(...args)
	}) as Awaited<ReturnType<AuditAdminPort[K]>>

	return {
		export: async(request) => await invoke('export', request),
		verifyIntegrity: async(filter) => await invoke('verifyIntegrity', filter),
		pruneBefore: async(cutoff, pruneOptions) => await invoke('pruneBefore', cutoff, pruneOptions)
	}
}
