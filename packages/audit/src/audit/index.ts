import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {AuditRuntime} from '@ooopsstudio/core/ports/audit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomAuditOptions} from './public/custom'
import type {DevelopmentAuditOptions} from './public/development'
import type {ProductionAuditOptions} from './public/production'
import {captureAuditCapability} from './utils/capabilities'

export type AuditOptions =
	| {readonly preset: 'development'; readonly options?: Omit<DevelopmentAuditOptions, 'clock' | 'lifecycle'>}
	| {readonly preset: 'production'; readonly options: Omit<ProductionAuditOptions, 'clock' | 'lifecycle'>}
	| {readonly preset: 'custom'; readonly options: Omit<CustomAuditOptions, 'clock' | 'lifecycle'>}

const registrationsInProgress = new WeakSet<object>()

function snapshotRegistrationObject(
	value: unknown,
	allowedFields: ReadonlySet<string> | undefined,
	label: string
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Audit ${label} is invalid.`)
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error()
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string' || (allowedFields && !allowedFields.has(key))) throw new Error()
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error()
			output[key] = descriptor.value
		}
	} catch { throw new Error(`Audit ${label} must contain only readable known fields.`) }
	return output
}

interface BoundAuditContainer {
	readonly identity: object
	readonly bind: (token: symbol, value: unknown) => void
	readonly unbind?: (token: symbol) => boolean
	readonly get: (token: symbol) => unknown
	readonly tryGet: (token: symbol) => unknown
	readonly has: (token: symbol) => boolean
}

function bindAuditContainer(container: Container): BoundAuditContainer {
	if (!container || typeof container !== 'object') throw new Error('Audit registration requires a valid container.')
	const bind = captureAuditCapability<[symbol, unknown], void>(container, 'bind')
	const unbind = captureAuditCapability<[symbol], boolean>(container, 'unbind')
	const get = captureAuditCapability<[symbol], unknown>(container, 'get')
	const tryGet = captureAuditCapability<[symbol], unknown>(container, 'tryGet')
	const has = captureAuditCapability<[symbol], boolean>(container, 'has')
	if (!bind || !get || !tryGet || !has) throw new Error('Audit registration requires a valid container.')
	return {identity: container, bind, ...(unbind ? {unbind} : {}), get, tryGet, has}
}

async function registerAuditOnce(container: BoundAuditContainer, configuration: AuditOptions): Promise<void> {
	const registration = snapshotRegistrationObject(configuration, new Set(['preset', 'options']), 'registration')
	if (!['development', 'production', 'custom'].includes(registration.preset as string)) {
		throw new Error('Audit registration preset is invalid.')
	}
	const preset = registration.preset as AuditOptions['preset']
	const providedOptions = registration.options === undefined
		? {}
		: snapshotRegistrationObject(registration.options, undefined, 'registration options')
	if (Object.hasOwn(providedOptions, 'clock') || Object.hasOwn(providedOptions, 'lifecycle')) {
		throw new Error('Audit registration options must contain only readable known fields.')
	}
	if (container.has(TOK.Audit) || container.has(TOK.AuditAdmin) || container.has(TOK.AuditTransactional)) {
		throw new Error('Audit service is already registered.')
	}
	if (!container.unbind) {
		throw new Error('Audit registration requires a container with unbind() for atomic token rollback.')
	}
	const clock = container.get(TOK.Clock) as Clock
	const lifecycle = container.tryGet(TOK.Lifecycle) as LifecyclePort | undefined
	const common = {
		clock,
		...(lifecycle ? {lifecycle} : {})
	}
	let runtime: AuditRuntime
	if (preset === 'development') {
		const {createDevelopmentAudit} = await import('./public/development')
		runtime = await createDevelopmentAudit({...providedOptions, ...common, clock})
	} else if (preset === 'production') {
		const {createProductionAudit} = await import('./public/production')
		runtime = await createProductionAudit({...providedOptions, ...common, clock} as unknown as ProductionAuditOptions)
	}
	else {
		const {createCustomAudit} = await import('./public/custom')
		runtime = await createCustomAudit({...providedOptions, ...common, clock} as unknown as CustomAuditOptions)
	}
	let bindingPhaseStarted = false
	try {
		if (container.has(TOK.Audit) || container.has(TOK.AuditAdmin) || container.has(TOK.AuditTransactional)) {
			throw new Error('Audit service was registered during runtime creation.')
		}
		bindingPhaseStarted = true
		container.bind(TOK.Audit, runtime.audit)
		if (runtime.transactional) container.bind(TOK.AuditTransactional, runtime.transactional)
		if (runtime.admin) container.bind(TOK.AuditAdmin, runtime.admin)
		if (container.tryGet(TOK.Audit) !== runtime.audit
			|| (runtime.transactional && container.tryGet(TOK.AuditTransactional) !== runtime.transactional)
			|| (runtime.admin && container.tryGet(TOK.AuditAdmin) !== runtime.admin)) {
			throw new Error('Audit container did not retain the registered runtime.')
		}
	} catch(error) {
		const cleanupFailures: unknown[] = []
		for (const token of [TOK.Audit, TOK.AuditTransactional, TOK.AuditAdmin] as const) {
			try {
				// Both tokens were proven absent immediately before this synchronous
				// binding phase. Any value now present was installed by the failed
				// attempt, even when a hostile container substituted another identity.
				if (bindingPhaseStarted && container.has(token)) container.unbind(token)
				if (bindingPhaseStarted && container.has(token)) {
					throw new Error('Audit registration rollback could not restore the original unbound state.')
				}
			} catch(cleanupError) { cleanupFailures.push(cleanupError) }
		}
		try {
			const [{AUDIT_SHUTDOWN_TIMEOUT_MS}, {withAuditTimeout}] = await Promise.all([
				import('./constants'), import('./utils/timeout')
			])
			await withAuditTimeout(runtime.audit.shutdown(), AUDIT_SHUTDOWN_TIMEOUT_MS, 'registration rollback')
		} catch(cleanupError) { cleanupFailures.push(cleanupError) }
		if (cleanupFailures.length > 0) {
			throw new AggregateError([error, ...cleanupFailures], 'Audit registration and rollback failed.')
		}
		throw error
	}
}

export async function registerAudit(container: Container, configuration: AuditOptions): Promise<void> {
	const boundContainer = bindAuditContainer(container)
	const identity = boundContainer.identity
	if (registrationsInProgress.has(identity)) throw new Error('Audit service is already registered.')
	registrationsInProgress.add(identity)
	try { return await registerAuditOnce(boundContainer, configuration) }
	finally { registrationsInProgress.delete(identity) }
}

export type {
	AuditAdminPort,
	AuditPort,
	AuditRuntime,
	AuditRuntimeState,
	AuditStatus,
	ManagedAudit,
	TransactionalAuditPort
} from '@ooopsstudio/core/ports/audit'
export type {CustomAuditOptions} from './public/custom'
export type {DevelopmentAuditOptions} from './public/development'
export type {ProductionAuditOptions} from './public/production'
export type {
	AuditAdminStore,
	AuditArchiveSink,
	AuditRedactionRule,
	AuditSerializationLimits,
	AuditStore,
	TransactionalAuditStore
} from './types/store'
