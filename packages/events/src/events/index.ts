import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {EventConsumerDefinition, EventConsumerHandler, EventDefinition} from '@ooopsstudio/core/contracts/events'
import type {EventsRuntime} from '@ooopsstudio/core/ports/events'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Container} from '@ooopsstudio/core/runtime'
import {captureSyncMethod, isolateUnexpectedThenable, snapshotBoundedDataGraph} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {TOK} from '@ooopsstudio/core/tokens'

import type {CustomEventsOptions} from './public/custom'
import type {DevelopmentEventsOptions} from './public/development'
import type {ProductionEventsOptions} from './public/production'
import {isolateArrayItemFields, isolateCapabilityFields, isolateEventsBackendInput, isolateInputFields} from './safe-input'
import type {EventDestination, EventsBackend} from './types'

export interface RegisteredEventConsumer {
	readonly definition: EventConsumerDefinition
	readonly handler: EventConsumerHandler
}

type CommonRegistration = {
	readonly definitions?: readonly EventDefinition[]
	readonly consumers?: readonly RegisteredEventConsumer[]
}
type Injected = 'clock' | 'lifecycle'
export type EventsOptions = CommonRegistration & (
	| {readonly preset: 'development'; readonly options?: Omit<DevelopmentEventsOptions, Injected>}
	| {readonly preset: 'production'; readonly options: Omit<ProductionEventsOptions, Injected>}
	| {readonly preset: 'custom'; readonly options: Omit<CustomEventsOptions, Injected>}
)

interface ContainerBoundary {
	has(token: symbol): boolean
	get(token: symbol): unknown
	tryGet(token: symbol): unknown
	bind(token: symbol, value: unknown): void
	unbind(token: symbol): unknown
}

const registrations = new WeakSet<object>()

function ownData(value: unknown, allowed: ReadonlySet<string>, code: string): Record<string, unknown> {
	for (const key of allowed) {
		try {
			const descriptor = value && (typeof value === 'object' || typeof value === 'function')
				? Object.getOwnPropertyDescriptor(value, key) : undefined
			if (descriptor && 'value' in descriptor) isolateUnexpectedThenable(descriptor.value)
		} catch(error) { isolateUnexpectedThenable(error) }
	}
	if (isolateUnexpectedThenable(value)) throw new TypeError(code)
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code)
	let keys: readonly PropertyKey[]
	try { keys = Reflect.ownKeys(value) } catch(error) { isolateUnexpectedThenable(error); throw new TypeError(code) }
	if (keys.length > allowed.size || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw new TypeError(code)
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	for (const key of keys as string[]) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch(error) { isolateUnexpectedThenable(error); throw new TypeError(code) }
		if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError(code)
		if (isolateUnexpectedThenable(descriptor.value)) throw new TypeError(code)
		result[key] = descriptor.value
	}
	return result
}

function snapshotArray(value: unknown, maximum: number, code: string): readonly unknown[] {
	if (isolateUnexpectedThenable(value)) throw new TypeError(code)
	if (!Array.isArray(value)) throw new TypeError(code)
	let length: number
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
		length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : Number.NaN
	} catch(error) { isolateUnexpectedThenable(error); throw new TypeError(code) }
	if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new TypeError(code)
	const result: unknown[] = []
	const descriptors: PropertyDescriptor[] = []
	let invalid = false
	for (let index = 0; index < length; index++) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)) } catch(error) { isolateUnexpectedThenable(error); throw new TypeError(code) }
		if (!descriptor?.enumerable || !('value' in descriptor)) { invalid = true; continue }
		if (isolateUnexpectedThenable(descriptor.value)) invalid = true
		descriptors.push(descriptor)
	}
	if (invalid || descriptors.length !== length) throw new TypeError(code)
	for (const descriptor of descriptors) result.push(descriptor.value)
	return Object.freeze(result)
}

function snapshotObject(value: unknown, allowed: readonly string[], code: string): Readonly<Record<string, unknown>> {
	return Object.freeze(ownData(value, new Set(allowed), code))
}

function snapshotRegistrationJson(value: unknown): unknown {
	try { return snapshotBoundedDataGraph(value) }
	catch(error) { isolateUnexpectedThenable(error); throw new TypeError('EVENTS_REGISTRATION_INVALID') }
}

function snapshotFields(owner: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
	if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) throw new TypeError('EVENTS_REGISTRATION_INVALID')
	if (isolateUnexpectedThenable(owner)) throw new TypeError('EVENTS_REGISTRATION_INVALID')
	const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	for (const name of names) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(owner, name) } catch(error) { isolateUnexpectedThenable(error); throw new TypeError('EVENTS_REGISTRATION_INVALID') }
		if (descriptor && !('value' in descriptor)) throw new TypeError('EVENTS_REGISTRATION_INVALID')
		fields[name] = descriptor?.value
	}
	return Object.freeze(fields)
}

function observedData(owner: unknown, name: string): unknown {
	isolateUnexpectedThenable(owner)
	if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(owner, name)
		if (descriptor && 'value' in descriptor) {
			isolateUnexpectedThenable(descriptor.value)
			return descriptor.value
		}
	} catch(error) { isolateUnexpectedThenable(error) }
	return undefined
}

function captureCapability(owner: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> {
	isolateCapabilityFields(owner, required, optional)
	const capability: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	for (const name of required) {
		const method = captureSyncMethod<unknown[], unknown>(owner, name)
		if (!method) throw new TypeError('EVENTS_REGISTRATION_INVALID')
		capability[name] = method
	}
	for (const name of optional) {
		const method = captureOptionalCapability(owner, name)
		if (method) capability[name] = method
	}
	return Object.freeze(capability)
}

function captureOptionalCapability(owner: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
	if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) throw new TypeError('EVENTS_REGISTRATION_INVALID')
	try {
		let current: object | null = owner
		const seen = new Set<object>()
		for (let depth = 0; current && depth < 32 && !seen.has(current); depth++) {
			seen.add(current)
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'function')) {
					throw new TypeError('EVENTS_REGISTRATION_INVALID')
				}
				if (descriptor.value === undefined) return undefined
				const method = descriptor.value as (...args: unknown[]) => unknown
				return (...args: unknown[]) => Reflect.apply(method, owner, args)
			}
			current = Object.getPrototypeOf(current)
		}
		if (current === null) return undefined
	} catch(error) { isolateUnexpectedThenable(error); throw new TypeError('EVENTS_REGISTRATION_INVALID') }
	throw new TypeError('EVENTS_REGISTRATION_INVALID')
}

function snapshotBackend(value: unknown): EventsBackend {
	isolateEventsBackendInput(value)
	const backend = snapshotFields(value, ['durability', 'outbox', 'inbox', 'transactional', 'admin', 'compatibility'])
	return Object.freeze({
		durability: backend.durability,
		outbox: captureCapability(backend.outbox,
			['append', 'claimDue', 'renew', 'complete', 'retry', 'deadLetter', 'purgeExpired', 'queuedCount'], ['flush', 'shutdown']),
		...(backend.inbox === undefined ? {} : {inbox: captureCapability(backend.inbox, ['claim', 'renew', 'complete', 'release'], ['flush', 'shutdown'])}),
		...(backend.transactional === undefined ? {} : {transactional: captureCapability(backend.transactional, ['appendTransactional'])}),
		...(backend.admin === undefined ? {} : {admin: captureCapability(backend.admin,
			['replay', 'retryDeadLetter', 'cancelScheduled', 'listOutbox', 'listDeadLetters', 'purgeExpired'])}),
		...(backend.compatibility === undefined ? {} : {compatibility: captureCapability(backend.compatibility, ['check'])})
	}) as unknown as EventsBackend
}

function snapshotDestination(value: unknown): EventDestination {
	const destination = snapshotFields(value, ['name', 'kind'])
	return Object.freeze({
		name: destination.name,
		kind: destination.kind,
		...captureCapability(value, ['deliver'], ['startConsumer', 'flush', 'shutdown'])
	}) as unknown as EventDestination
}

function snapshotRegistration(value: unknown): EventsOptions {
	const root = ownData(value, new Set(['preset', 'options', 'definitions', 'consumers']), 'EVENTS_REGISTRATION_INVALID')
	const preset = root.preset
	if (preset !== 'development' && preset !== 'production' && preset !== 'custom') throw new TypeError('EVENTS_REGISTRATION_INVALID')
	const rawOptions = root.options === undefined
		? undefined
		: snapshotObject(root.options, preset === 'development'
			? ['maxRecords']
			: preset === 'production'
				? ['backend', 'role', 'destinations']
				: ['backend', 'role', 'destinations', 'strictDefinitions', 'inline', 'delivery'], 'EVENTS_REGISTRATION_INVALID')
	const options = rawOptions === undefined ? undefined : Object.freeze({
		...rawOptions,
		...(rawOptions.backend === undefined ? {} : {backend: snapshotBackend(rawOptions.backend)}),
		...(rawOptions.destinations === undefined ? {} : {
			destinations: Object.freeze(snapshotArray(rawOptions.destinations, 16, 'EVENTS_REGISTRATION_INVALID').map(snapshotDestination))
		}),
		...(rawOptions.delivery === undefined ? {} : {
			delivery: snapshotObject(rawOptions.delivery, [
				'pollIntervalMs', 'maintenanceIntervalMs', 'operationTimeoutMs', 'shutdownTimeoutMs',
				'maxAttempts', 'maxConcurrent'
			], 'EVENTS_REGISTRATION_INVALID')
		})
	})
	if ((preset === 'production' || preset === 'custom') && options === undefined) throw new TypeError('EVENTS_REGISTRATION_INVALID')
	const definitionInputs = snapshotArray(root.definitions ?? [], 1_000, 'EVENTS_REGISTRATION_INVALID')
	isolateArrayItemFields(definitionInputs, [
		'type', 'source', 'summary', 'description', 'aggregateType', 'schema', 'binding', 'defaultHeaders', 'version', 'tags'
	], 1_000)
	let nestedInvalid = false
	for (const definition of definitionInputs) {
		isolateCapabilityFields(observedData(definition, 'schema'), ['parse'])
		const binding = observedData(definition, 'binding')
		isolateInputFields(binding, ['destination', 'target', 'options'])
		for (const candidate of [observedData(binding, 'options'), observedData(definition, 'defaultHeaders'), observedData(definition, 'tags')]) {
			if (candidate === undefined) continue
			try { snapshotBoundedDataGraph(candidate) }
			catch(error) { isolateUnexpectedThenable(error); nestedInvalid = true }
		}
	}
	if (nestedInvalid) throw new TypeError('EVENTS_REGISTRATION_INVALID')
	const definitions = definitionInputs.map((definition) => {
		const record = snapshotObject(definition, ['type', 'source', 'summary', 'description', 'aggregateType', 'schema', 'binding', 'defaultHeaders', 'version', 'tags'], 'EVENTS_REGISTRATION_INVALID')
		const parse = captureSyncMethod<[unknown], unknown>(record.schema, 'parse')
		if (!parse) throw new TypeError('EVENTS_REGISTRATION_INVALID')
		const bindingRecord = record.binding === undefined
			? undefined
			: snapshotObject(record.binding, ['destination', 'target', 'options'], 'EVENTS_REGISTRATION_INVALID')
		const binding = bindingRecord === undefined ? undefined : Object.freeze({
			...bindingRecord,
			...(bindingRecord.options === undefined ? {} : {options: snapshotRegistrationJson(bindingRecord.options)})
		})
		return Object.freeze({
			...record,
			schema: Object.freeze({parse}),
			...(binding === undefined ? {} : {binding}),
			...(record.defaultHeaders === undefined ? {} : {defaultHeaders: snapshotRegistrationJson(record.defaultHeaders)}),
			...(record.tags === undefined ? {} : {tags: snapshotArray(record.tags, 32, 'EVENTS_REGISTRATION_INVALID')})
		}) as unknown as EventDefinition
	})
	const consumerInputs = snapshotArray(root.consumers ?? [], 256, 'EVENTS_REGISTRATION_INVALID')
	isolateArrayItemFields(consumerInputs, ['definition', 'handler'], 256)
	for (const entry of consumerInputs) {
		const definition = observedData(entry, 'definition')
		isolateInputFields(definition, ['name', 'eventTypes', 'concurrency'])
		const eventTypes = observedData(definition, 'eventTypes')
		try { if (eventTypes !== undefined) snapshotBoundedDataGraph(eventTypes) }
		catch(error) { isolateUnexpectedThenable(error); nestedInvalid = true }
	}
	if (nestedInvalid) throw new TypeError('EVENTS_REGISTRATION_INVALID')
	const consumers = consumerInputs.map((entry) => {
		const record = snapshotObject(entry, ['definition', 'handler'], 'EVENTS_REGISTRATION_INVALID')
		if (typeof record.handler !== 'function') throw new TypeError('EVENTS_REGISTRATION_INVALID')
		const definition = snapshotObject(record.definition, ['name', 'eventTypes', 'concurrency'], 'EVENTS_REGISTRATION_INVALID')
		return Object.freeze({
			definition: Object.freeze({...definition,
				eventTypes: snapshotArray(definition.eventTypes, 64, 'EVENTS_REGISTRATION_INVALID')}) as unknown as EventConsumerDefinition,
			handler: record.handler as EventConsumerHandler
		})
	})
	return Object.freeze({preset, ...(options === undefined ? {} : {options}), definitions: Object.freeze(definitions), consumers: Object.freeze(consumers)}) as EventsOptions
}

function captureContainer(value: Container): ContainerBoundary {
	const has = captureSyncMethod<[symbol], boolean>(value, 'has')
	const get = captureSyncMethod<[symbol], unknown>(value, 'get')
	const tryGet = captureSyncMethod<[symbol], unknown>(value, 'tryGet')
	const bind = captureSyncMethod<[symbol, unknown], void>(value, 'bind')
	const unbind = captureSyncMethod<[symbol], unknown>(value, 'unbind')
	if (!has || !get || !tryGet || !bind || !unbind) throw new TypeError('EVENTS_CONTAINER_INVALID')
	return {
		has(token) { const result = has(token); isolateUnexpectedThenable(result); if (typeof result !== 'boolean') throw new TypeError('EVENTS_CONTAINER_INVALID'); return result },
		get(token) { const result = get(token); isolateUnexpectedThenable(result); return result },
		tryGet(token) { const result = tryGet(token); isolateUnexpectedThenable(result); return result },
		bind(token, item) { const result = bind(token, item); isolateUnexpectedThenable(result) },
		unbind(token) { const result = unbind(token); isolateUnexpectedThenable(result); return result }
	}
}

export async function registerEvents(containerValue: Container, configurationValue: EventsOptions): Promise<void> {
	const containerThenable = isolateUnexpectedThenable(containerValue)
	isolateUnexpectedThenable(configurationValue)
	if (!containerValue || (typeof containerValue !== 'object' && typeof containerValue !== 'function') || containerThenable) {
		throw new TypeError('EVENTS_CONTAINER_INVALID')
	}
	if (registrations.has(containerValue)) throw new Error('EVENTS_ALREADY_REGISTERED')
	registrations.add(containerValue)
	let runtime: EventsRuntime | undefined
	let container: ContainerBoundary | undefined
	const ownedBindings: Array<readonly [symbol, unknown]> = []
	try {
		const configuration = snapshotRegistration(configurationValue)
		container = captureContainer(containerValue)
		const tokens = [TOK.Events, TOK.EventsTransactional, TOK.EventsAdmin] as const
		if (tokens.some((token) => container!.has(token))) throw new Error('EVENTS_ALREADY_REGISTERED')
		const clock = captureCapability(container.get(TOK.Clock), ['now']) as unknown as Clock
		const lifecycleValue = container.tryGet(TOK.Lifecycle)
		const common = {
			clock,
			lifecycle: lifecycleValue === undefined ? undefined : captureCapability(
				lifecycleValue, ['registerFlushHook', 'registerShutdownHook']) as unknown as LifecyclePort
		}
		if (configuration.preset === 'development') {
			const {createDevelopmentEvents} = await import('./public/development')
			runtime = await createDevelopmentEvents({...configuration.options, ...common})
		} else if (configuration.preset === 'production') {
			const {createProductionEvents} = await import('./public/production')
			runtime = await createProductionEvents({...configuration.options, ...common} as ProductionEventsOptions)
		} else {
			const {createCustomEvents} = await import('./public/custom')
			runtime = await createCustomEvents({...configuration.options, ...common} as CustomEventsOptions)
		}
		for (const definition of configuration.definitions ?? []) runtime.events.registerDefinition(definition)
		for (const consumer of configuration.consumers ?? []) runtime.events.registerConsumer(consumer.definition, consumer.handler)
		await runtime.events.start()
		if (tokens.some((token) => container!.has(token))) throw new Error('EVENTS_REGISTERED_DURING_CREATION')
		const bind = (token: symbol, item: unknown): void => {
			if (container!.has(token)) throw new Error('EVENTS_REGISTERED_DURING_BINDING')
			ownedBindings.push([token, item])
			container!.bind(token, item)
			if (container!.tryGet(token) !== item) throw new Error('EVENTS_BINDING_NOT_RETAINED')
		}
		bind(TOK.Events, runtime.events)
		if (runtime.transactional) bind(TOK.EventsTransactional, runtime.transactional)
		if (runtime.admin) bind(TOK.EventsAdmin, runtime.admin)
	} catch(error) {
		isolateUnexpectedThenable(error)
		const failures: unknown[] = []
		if (!container) try { container = captureContainer(containerValue) } catch(cleanup) { isolateUnexpectedThenable(cleanup); failures.push(cleanup) }
		if (container) {
			for (const [token, item] of ownedBindings.reverse()) {
				try {
					if (container.tryGet(token) === item) container.unbind(token)
					if (container.tryGet(token) === item) throw new Error('EVENTS_ROLLBACK_FAILED')
				}
				catch(cleanup) { isolateUnexpectedThenable(cleanup); failures.push(cleanup) }
			}
		}
		if (runtime) {
			try { await runtime.events.shutdown() }
			catch(cleanup) { isolateUnexpectedThenable(cleanup); failures.push(cleanup) }
		}
		if (failures.length) throw new AggregateError([error, ...failures], 'Events registration and rollback failed')
		throw error
	} finally {
		registrations.delete(containerValue)
	}
}

export * from './public/types'
