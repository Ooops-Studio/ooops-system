import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'
import {setTimeout as wait} from 'node:timers/promises'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {
	EventConsumerDefinition,
	EventConsumerHandler,
	EventDeadLetterSummary,
	EventDefinition,
	EventDeliveryStatus,
	EventEnvelope,
	EventOutboxSummary,
	EventPublishOptions,
	EventPublishRequest,
	EventsStatus
} from '@ooopsstudio/core/contracts/events'
import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LifecycleHookDisposer} from '@ooopsstudio/core/contracts/lifecycle'
import type {EventsAdminPort, EventsRuntime, ManagedEvents, TransactionalEventsPort} from '@ooopsstudio/core/ports/events'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSafeAbortController, isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {isolateArrayItemFields, isolateCapabilityFields, isolateEventsBackendInput, isolateInputFields} from './safe-input'
import {registerEventsTelemetry, type EventsTelemetryAttachment} from './telemetry'
import type {
	EventAdminStore,
	EventBackendCompatibility,
	EventDeliveryResult,
	EventDestination,
	EventInboxStore,
	EventOutboxStore,
	EventsBackend,
	StoredEventRecord,
	TransactionalEventStore
} from './types'

export type EventsRole = 'publisher' | 'worker' | 'combined'

export interface EventsManagerOptions {
	readonly clock: Clock
	readonly backend: EventsBackend
	readonly role: EventsRole
	readonly destinations?: readonly EventDestination[]
	readonly lifecycle?: LifecyclePort
	readonly strictDefinitions?: boolean
	readonly inline?: boolean
	readonly pollIntervalMs?: number
	readonly maintenanceIntervalMs?: number
	readonly operationTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
	readonly maxAttempts?: number
	readonly maxConcurrent?: number
}

type Consumer = {
	definition: EventConsumerDefinition
	handler: EventConsumerHandler
	active: number
	waiters: Array<() => void>
}

const dataProperty = (value: unknown, name: string): unknown => {
	try {
		const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, name) : undefined
		if (!descriptor || !('value' in descriptor)) return undefined
		isolateUnexpectedThenable(descriptor.value)
		return descriptor.value
	} catch(error) { isolateUnexpectedThenable(error); return undefined }
}
const failureCode = (error: unknown, fallback = 'EVENTS_OPERATION_FAILURE'): string => {
	isolateInputFields(error, ['code', 'message', 'permanent', 'retryAfterMs', 'ingress'])
	const code = dataProperty(error, 'code')
	return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(code) ? code : fallback
}
const BACKEND_RESULT_INVALID = 'EVENTS_BACKEND_RESULT_INVALID'
const EXTENSION_INVALID = 'EVENTS_EXTENSION_INVALID'
const OUTBOX_LEASE_LOST = 'EVENTS_OUTBOX_LEASE_LOST'
const permanentFailure = (code: string): Error => Object.assign(new Error(code), {code, permanent: true})
const iso = (value: number): string => new Date(value).toISOString()

function isolateJsonThenables(value: unknown, maxDepth = 8): void {
	let observedNodes = 0
	const observed = new WeakSet<object>()
	const observe = (input: unknown, depth: number): void => {
		if (isolateUnexpectedThenable(input) || input === null || typeof input !== 'object'
			|| observed.has(input) || depth > maxDepth || ++observedNodes > 10_000) return
		observed.add(input)
		try {
			if (Array.isArray(input)) {
				const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length')
				const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : 0
				if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) return
				for (let index = 0; index < length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
					if (descriptor && 'value' in descriptor) observe(descriptor.value, depth + 1)
				}
				return
			}
			const prototype = Object.getPrototypeOf(input)
			if (prototype !== Object.prototype && prototype !== null) return
			const keys = Reflect.ownKeys(input)
			if (keys.length > 1_000) return
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key)
				if (descriptor && 'value' in descriptor) observe(descriptor.value, depth + 1)
			}
		} catch(error) { isolateUnexpectedThenable(error) }
	}
	observe(value, 0)
	return undefined
}

function snapshotJson(value: unknown, maxBytes: number, maxDepth = 8): JsonValue {
	isolateJsonThenables(value, maxDepth)
	let nodes = 0
	let bytes = 0
	const seen = new WeakSet<object>()
	const addBytes = (value: string): void => {
		bytes += Buffer.byteLength(value)
		if (bytes > maxBytes) throw new Error('EVENTS_PAYLOAD_LIMIT')
	}
	const visit = (input: unknown, depth: number): JsonValue => {
		if (depth > maxDepth || ++nodes > 10_000) throw new Error('EVENTS_PAYLOAD_LIMIT')
		if (isolateUnexpectedThenable(input)) throw new Error('EVENTS_PAYLOAD_INVALID')
		if (input === null) { addBytes('null'); return input }
		if (typeof input === 'boolean') { addBytes(input ? 'true' : 'false'); return input }
		if (typeof input === 'number') {
			if (!Number.isFinite(input)) throw new Error('EVENTS_PAYLOAD_INVALID')
			addBytes(String(input))
			return input
		}
		if (typeof input === 'string') {
			addBytes(JSON.stringify(input))
			return input
		}
		if (!input || typeof input !== 'object' || seen.has(input)) throw new Error('EVENTS_PAYLOAD_INVALID')
		seen.add(input)
		try {
			if (Array.isArray(input)) {
				const keys = Reflect.ownKeys(input)
				const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length')
				const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
				if (!Number.isSafeInteger(length) || length < 0 || length > 10_000 || keys.length !== length + 1) throw new Error('EVENTS_PAYLOAD_LIMIT')
				addBytes(length === 0 ? '[]' : `[${','.repeat(length - 1)}]`)
				const output: JsonValue[] = []
				for (let index = 0; index < length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
					if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('EVENTS_PAYLOAD_INVALID')
					output.push(visit(descriptor.value, depth + 1))
				}
				return Object.freeze(output)
			}
			const prototype = Object.getPrototypeOf(input)
			if (prototype !== Object.prototype && prototype !== null) throw new Error('EVENTS_PAYLOAD_INVALID')
			const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
			const keys = Reflect.ownKeys(input)
			if (keys.length > 1_000) throw new Error('EVENTS_PAYLOAD_LIMIT')
			addBytes('{}')
			for (const [index, key] of keys.entries()) {
				if (typeof key !== 'string' || key.length > 128) throw new Error('EVENTS_PAYLOAD_INVALID')
				const descriptor = Object.getOwnPropertyDescriptor(input, key)
				if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('EVENTS_PAYLOAD_INVALID')
				addBytes(`${index === 0 ? '' : ','}${JSON.stringify(key)}:`)
				output[key] = visit(descriptor.value, depth + 1)
			}
			return Object.freeze(output)
		}
		finally { seen.delete(input) }
	}
	return visit(value, 0)
}
const freeze = <T>(value: T): T => snapshotJson(value, 2_000_000, 16) as T
async function bounded<T>(work: Promise<T>, timeoutMs: number, code: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), {code})), timeoutMs) })])
	} finally { if (timer) clearTimeout(timer) }
}

async function observeOnce<T>(wrapper: (work: () => Promise<T>) => T | Promise<T>, work: () => T | Promise<T>): Promise<T> {
	let operation: Promise<T> | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	const once = (): Promise<T> => operation ??= Promise.resolve().then(work)
	const fallback = new Promise<T>((resolve, reject) => {
		timer = setTimeout(() => { void once().then(resolve, reject) }, 100)
	})
	try {
		const observed = Promise.resolve().then(() => wrapper(once)).then(() => once())
		return await Promise.race([observed, fallback])
	} catch(error) { isolateUnexpectedThenable(error); return once() }
	finally { if (timer) clearTimeout(timer) }
}

function safeObject(value: unknown, code: string, maximum = 64): Record<string, unknown> {
	try {
		if (isolateUnexpectedThenable(value)) throw new Error(code)
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new Error(code)
		const keys = Reflect.ownKeys(value)
		if (keys.length > maximum) throw new Error(code)
		const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		const descriptors = new Map<string, PropertyDescriptor>()
		let invalid = false
		for (const key of keys) {
			if (typeof key !== 'string') { invalid = true; continue }
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) { invalid = true; continue }
			if (isolateUnexpectedThenable(descriptor.value)) invalid = true
			descriptors.set(key, descriptor)
		}
		if (invalid || descriptors.size !== keys.length) throw new Error(code)
		for (const [key, descriptor] of descriptors) output[key] = descriptor.value
		return output
	} catch(error) { isolateUnexpectedThenable(error); throw new Error(code) }
}

function snapshotArray(value: unknown, maximum: number, code: string): unknown[] {
	try {
		if (isolateUnexpectedThenable(value)) throw new Error(code)
		if (!Array.isArray(value)) throw new Error(code)
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
		const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined
		const keys = Reflect.ownKeys(value)
		if (!Number.isSafeInteger(length) || length < 0 || length > maximum || keys.length !== length + 1) throw new Error(code)
		const output: unknown[] = []
		const descriptors: PropertyDescriptor[] = []
		let invalid = false
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor?.enumerable || !('value' in descriptor)) { invalid = true; continue }
			if (isolateUnexpectedThenable(descriptor.value)) invalid = true
			descriptors.push(descriptor)
		}
		if (invalid || descriptors.length !== length) throw new Error(code)
		for (const descriptor of descriptors) output.push(descriptor.value)
		return output
	} catch(error) { isolateUnexpectedThenable(error); throw new Error(code) }
}

function optionalString(value: unknown, maximum: number, code: string): string | undefined {
	if (value === undefined) return undefined
	if (isolateUnexpectedThenable(value)) throw new Error(code)
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(code)
	return value
}

function timestampOption(value: unknown, fallback: number): number {
	if (value === undefined) return fallback
	if (isolateUnexpectedThenable(value)) throw new Error('EVENTS_TIME_INVALID')
	let result: number
	try {
		if (typeof value === 'string') result = Date.parse(value)
		else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Date.prototype) {
			result = Date.prototype.getTime.call(value)
		} else throw new Error('EVENTS_TIME_INVALID')
	} catch(error) { isolateUnexpectedThenable(error); throw new Error('EVENTS_TIME_INVALID') }
	if (!Number.isFinite(result)) throw new Error('EVENTS_TIME_INVALID')
	return result
}

function captureMethod<T extends object, K extends keyof T>(target: T, name: K): T[K] {
	try {
		let current: object | null = target
		const seen = new Set<object>()
		for (let depth = 0; current && depth < 29 && !seen.has(current); depth++) {
			seen.add(current)
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if ('value' in descriptor) isolateUnexpectedThenable(descriptor.value)
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error(EXTENSION_INVALID)
				const method = descriptor.value as (...args: unknown[]) => unknown
				return ((...args: unknown[]) => Reflect.apply(method, target, args)) as T[K]
			}
			current = Object.getPrototypeOf(current)
		}
	} catch(error) { isolateUnexpectedThenable(error); throw new Error(EXTENSION_INVALID) }
	throw new Error(EXTENSION_INVALID)
}

function captureOptionalMethod<T extends object, K extends keyof T>(target: T, name: K): T[K] | undefined {
	try {
		let current: object | null = target
		const seen = new Set<object>()
		for (let depth = 0; current && depth < 29 && !seen.has(current); depth++) {
			seen.add(current)
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if ('value' in descriptor) isolateUnexpectedThenable(descriptor.value)
				if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'function')) {
					throw new Error(EXTENSION_INVALID)
				}
				if (descriptor.value === undefined) return undefined
				const method = descriptor.value as (...args: unknown[]) => unknown
				return ((...args: unknown[]) => Reflect.apply(method, target, args)) as T[K]
			}
			current = Object.getPrototypeOf(current)
		}
		if (current === null) return undefined
	} catch(error) { isolateUnexpectedThenable(error); throw new Error(EXTENSION_INVALID) }
	throw new Error(EXTENSION_INVALID)
}

export async function createEventsManager(options: EventsManagerOptions): Promise<EventsRuntime> {
	isolateInputFields(options, [
		'clock', 'backend', 'role', 'destinations', 'lifecycle', 'strictDefinitions', 'inline', 'pollIntervalMs',
		'maintenanceIntervalMs', 'operationTimeoutMs', 'shutdownTimeoutMs', 'maxAttempts', 'maxConcurrent'
	])
	const option = (name: string): unknown => dataProperty(options, name)
	const backendInput = option('backend') as EventsBackend
	const clockInput = option('clock') as Clock
	const lifecycleOption = option('lifecycle') as LifecyclePort | undefined
	const destinationsOption = option('destinations')
	isolateEventsBackendInput(backendInput)
	isolateCapabilityFields(clockInput, ['now'])
	isolateCapabilityFields(lifecycleOption, ['registerFlushHook', 'registerShutdownHook'])
	isolateArrayItemFields(destinationsOption, ['name', 'kind', 'deliver', 'startConsumer', 'flush', 'shutdown'])
	const role = option('role') as EventsRole
	if (isolateUnexpectedThenable(role)) throw new Error('EVENTS_OPTIONS_INVALID')
	if (!['publisher', 'worker', 'combined'].includes(role)) throw new Error('EVENTS_OPTIONS_INVALID')
	const integerOption = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
		if (isolateUnexpectedThenable(value)) throw new Error('EVENTS_OPTIONS_INVALID')
		const result = value ?? fallback
		if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error('EVENTS_OPTIONS_INVALID')
		return result
	}
	const pollInterval = integerOption(option('pollIntervalMs') as number | undefined, 250, 10, 2_147_483_647)
	const maintenanceInterval = integerOption(option('maintenanceIntervalMs') as number | undefined, 30_000, 100, 2_147_483_647)
	const operationTimeoutInput = option('operationTimeoutMs') as number | undefined
	const operationTimeout = integerOption(operationTimeoutInput, 10_000, 100, 2_147_483_647)
	const shutdownTimeout = integerOption(option('shutdownTimeoutMs') as number | undefined, 30_000, 100, 2_147_483_647)
	const maxAttempts = integerOption(option('maxAttempts') as number | undefined, 8, 1, 100)
	const maxConcurrent = integerOption(option('maxConcurrent') as number | undefined, 16, 1, 32)
	const inline = option('inline') as boolean | undefined
	const strictDefinitions = option('strictDefinitions') as boolean | undefined
	if (isolateUnexpectedThenable(inline) || isolateUnexpectedThenable(strictDefinitions)) throw new Error('EVENTS_OPTIONS_INVALID')
	if (inline !== undefined && typeof inline !== 'boolean') throw new Error('EVENTS_OPTIONS_INVALID')
	if (strictDefinitions !== undefined && typeof strictDefinitions !== 'boolean') throw new Error('EVENTS_OPTIONS_INVALID')
	const clockNow = captureMethod(clockInput, 'now')
	const now = (): number => {
		let value: unknown
		try { value = clockNow() }
		catch(error) {
			if (isolateUnexpectedThenable(error)) throw new Error('EVENTS_CLOCK_INVALID')
			throw error
		}
		if (isolateUnexpectedThenable(value)) throw new Error('EVENTS_CLOCK_INVALID')
		if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 9_007_197_107_257_344) throw new Error('EVENTS_CLOCK_INVALID')
		return value
	}
	const worker = role === 'worker' || role === 'combined'
	const backendDurability = dataProperty(backendInput, 'durability')
	const compatibilityInput = dataProperty(backendInput, 'compatibility') as EventsBackend['compatibility']
	const inboxInput = dataProperty(backendInput, 'inbox') as EventsBackend['inbox']
	if (!['ephemeral', 'durable'].includes(backendDurability as string)) throw new Error('EVENTS_BACKEND_INVALID')
	if (backendDurability === 'durable' && !compatibilityInput) throw new Error('EVENTS_COMPATIBILITY_REQUIRED')
	if (worker && backendDurability === 'durable' && !inboxInput) throw new Error('EVENTS_ATOMIC_INBOX_REQUIRED')
	const destinationInputs = snapshotArray(destinationsOption ?? [], 16, 'EVENTS_DESTINATIONS_INVALID') as EventDestination[]
	const destinationList: readonly EventDestination[] = destinationInputs.map((destination) => {
		isolateCapabilityFields(destination, ['deliver'], ['startConsumer', 'flush', 'shutdown'])
		const name = optionalString(dataProperty(destination, 'name'), 128, 'EVENTS_DESTINATIONS_INVALID')
		const kind = dataProperty(destination, 'kind')
		if (!name || !['http', 'kafka', 'nats', 'custom'].includes(kind as string)) throw new Error('EVENTS_DESTINATIONS_INVALID')
		return {
			name, kind: kind as EventDestination['kind'], deliver: captureMethod(destination, 'deliver'),
			startConsumer: captureOptionalMethod(destination, 'startConsumer'),
			flush: captureOptionalMethod(destination, 'flush'),
			shutdown: captureOptionalMethod(destination, 'shutdown')
		}
	})
	const destinations = new Map(destinationList.map((destination) => [destination.name, destination]))
	if (destinations.size !== destinationList.length || destinations.size > 16) throw new Error('EVENTS_DESTINATIONS_INVALID')
	const outboxInput = dataProperty(backendInput, 'outbox') as EventsBackend['outbox']
	const outbox: EventOutboxStore = {
		append: captureMethod(outboxInput, 'append'), claimDue: captureMethod(outboxInput, 'claimDue'),
		renew: captureMethod(outboxInput, 'renew'), complete: captureMethod(outboxInput, 'complete'),
		retry: captureMethod(outboxInput, 'retry'), deadLetter: captureMethod(outboxInput, 'deadLetter'),
		purgeExpired: captureMethod(outboxInput, 'purgeExpired'), queuedCount: captureMethod(outboxInput, 'queuedCount'),
		flush: captureOptionalMethod(outboxInput, 'flush'), shutdown: captureOptionalMethod(outboxInput, 'shutdown')
	}
	const inbox: EventInboxStore | undefined = inboxInput ? {
		claim: captureMethod(inboxInput, 'claim'), renew: captureMethod(inboxInput, 'renew'),
		complete: captureMethod(inboxInput, 'complete'), release: captureMethod(inboxInput, 'release'),
		flush: captureOptionalMethod(inboxInput, 'flush'),
		shutdown: captureOptionalMethod(inboxInput, 'shutdown')
	} : undefined
	const compatibility: EventBackendCompatibility | undefined = compatibilityInput
		? {check: captureMethod(compatibilityInput, 'check')}
		: undefined
	const transactionalInput = dataProperty(backendInput, 'transactional') as EventsBackend['transactional']
	const transactionalStore: TransactionalEventStore | undefined = transactionalInput
		? {appendTransactional: captureMethod(transactionalInput, 'appendTransactional')}
		: undefined
	const adminInput = dataProperty(backendInput, 'admin') as EventsBackend['admin']
	const adminStore: EventAdminStore | undefined = adminInput ? {
		replay: captureMethod(adminInput, 'replay'), retryDeadLetter: captureMethod(adminInput, 'retryDeadLetter'),
		cancelScheduled: captureMethod(adminInput, 'cancelScheduled'), listOutbox: captureMethod(adminInput, 'listOutbox'),
		listDeadLetters: captureMethod(adminInput, 'listDeadLetters'), purgeExpired: captureMethod(adminInput, 'purgeExpired')
	} : undefined
	const lifecycleInput = lifecycleOption
	isolateCapabilityFields(lifecycleInput, ['registerFlushHook', 'registerShutdownHook'])
	const registerFlushHook = lifecycleInput ? captureMethod(lifecycleInput, 'registerFlushHook') : undefined
	const registerShutdownHook = lifecycleInput ? captureMethod(lifecycleInput, 'registerShutdownHook') : undefined
	if (compatibility) {
		let compatibilityResult: unknown
		try {
			compatibilityResult = await bounded(Promise.resolve().then(() => compatibility.check()),
				operationTimeoutInput === undefined ? 5_000 : operationTimeout, 'EVENTS_COMPATIBILITY_TIMEOUT')
		} catch(error) { isolateUnexpectedThenable(error); throw error }
		const result = safeObject(compatibilityResult, BACKEND_RESULT_INVALID, 2)
		if (result.compatible !== true && result.compatible !== false) throw new Error(BACKEND_RESULT_INVALID)
		if (!result.compatible) {
			const code = result.code === undefined ? 'EVENTS_SCHEMA_INCOMPATIBLE' : optionalString(result.code, 128, BACKEND_RESULT_INVALID)
			if (!code || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(code)) throw new Error(BACKEND_RESULT_INVALID)
			throw Object.assign(new Error('EVENTS_SCHEMA_INCOMPATIBLE'), {code})
		}
	}
	const definitions = new Map<string, EventDefinition>()
	const consumers = new Map<string, Consumer>()
	const owner = `events-${randomUUID()}`
	const active = new Set<Promise<unknown>>()
	const physicalWork = new Set<Promise<unknown>>()
	const controllers = new Set<AbortController>()
	const disposers: LifecycleHookDisposer[] = []
	const destinationStops: Array<() => void | Promise<void>> = []
	let state: EventsStatus['state'] = 'idle'
	let registrationClosed = false
	let backendState: EventsStatus['backendState'] = 'healthy'
	let lastFailureCode: string | undefined
	let retriedTotal = 0
	let deadLetteredTotal = 0
	let queuedEvents = 0
	let pollTimer: ReturnType<typeof setInterval> | undefined
	let maintenanceTimer: ReturnType<typeof setInterval> | undefined
	let maintaining = false
	let inboundActive = 0
	let startFlight: Promise<void> | undefined
	let flushFlight: Promise<void> | undefined
	let shutdownFlight: Promise<void> | undefined
	type LifecycleKind = 'operation' | 'start' | 'flush' | 'shutdown'
	const lifecycleReentry = new AsyncLocalStorage<{active: boolean; kind: LifecycleKind}>()
	const runLifecycle = <T>(kind: LifecycleKind, work: () => Promise<T>): Promise<T> => {
		const marker = {active: true, kind}
		return lifecycleReentry.run(marker, async() => {
			try { return await work() }
			catch(error) { isolateUnexpectedThenable(error); throw error }
			finally { marker.active = false }
		})
	}
	const activeLifecycle = (): boolean => lifecycleReentry.getStore()?.active === true
	const finalizationSteps = new Map<string, Promise<void>>()
	const completedFinalizationSteps = new Set<string>()
	let attached: EventsTelemetryAttachment | undefined
	let attachmentUsed = false
	const emit = (event: Parameters<EventsTelemetryAttachment['emit']>[0]): void => {
		try { isolateUnexpectedThenable(attached?.emit(event)) }
		catch(error) { isolateUnexpectedThenable(error) }
	}
	const own = <T>(promise: Promise<T>): Promise<T> => {
		active.add(promise); emit({kind: 'active', value: active.size})
		void promise.finally(() => { active.delete(promise); emit({kind: 'active', value: active.size}) }).catch(() => {})
		return promise
	}
	const trackPhysical = <T>(promise: Promise<T>): Promise<T> => {
		physicalWork.add(promise)
		void promise.then(() => physicalWork.delete(promise), () => physicalWork.delete(promise))
		return promise
	}
	const backendCall = async <T>(work: Promise<T>): Promise<T> => {
		const physical = trackPhysical(Promise.resolve(work))
		try {
			let result: T
			try { result = await bounded(physical, operationTimeout, 'EVENTS_BACKEND_TIMEOUT') }
			catch(error) {
				if (failureCode(error) !== 'EVENTS_BACKEND_TIMEOUT') throw error
				result = await physical
			}
			backendState = 'healthy'; lastFailureCode = undefined
			return result
		} catch(error) {
			backendState = 'unhealthy'; lastFailureCode = failureCode(error, 'EVENTS_BACKEND_FAILURE'); throw error
		}
	}
	const backendBoolean = async(work: Promise<boolean>): Promise<boolean> => {
		const result = await backendCall(work)
		if (typeof result !== 'boolean') throw new Error(BACKEND_RESULT_INVALID)
		return result
	}
	const fenceLease = <T>(work: Promise<T>, controller: AbortController, failed: (error: unknown) => void): Promise<T> => {
		const error = Object.assign(new Error('EVENTS_BACKEND_TIMEOUT'), {code: 'EVENTS_BACKEND_TIMEOUT'})
		const timer = setTimeout(() => { failed(error); controller.abort(error) }, Math.min(operationTimeout, 10_000))
		return work.finally(() => clearTimeout(timer))
	}
	const extensionCall = async <T>(work: Promise<T>, timeoutCode: string): Promise<T> => {
		const physical = trackPhysical(work)
		try { return await bounded(physical, operationTimeout, timeoutCode) }
		catch(error) {
			if (failureCode(error) !== timeoutCode) throw error
			return physical
		}
	}
	const settleOwned = async(): Promise<void> => {
		while (active.size > 0 || physicalWork.size > 0) {
			await Promise.allSettled([...active, ...physicalWork])
		}
	}
	const finalizeStep = async(
		name: string,
		work: () => void | Promise<void>,
		timeoutCode: string,
		timeoutMs = operationTimeout
	): Promise<void> => {
		if (completedFinalizationSteps.has(name)) return
		let physical = finalizationSteps.get(name)
		if (!physical) {
			physical = Promise.resolve().then(work)
			finalizationSteps.set(name, physical)
			void physical.then(() => {
				completedFinalizationSteps.add(name)
				finalizationSteps.delete(name)
			}, () => {
				finalizationSteps.delete(name)
			})
		}
		await bounded(physical, timeoutMs, timeoutCode)
	}
	const build = <T>(type: string, payload: T, input?: EventPublishOptions): {envelope: EventEnvelope<T>; record: StoredEventRecord} => {
		if (state === 'draining' || state === 'closed') throw new Error('EVENTS_ADMISSION_CLOSED')
		if (typeof type !== 'string' || !type || type.length > 160) throw new Error('EVENTS_TYPE_INVALID')
		const definition = definitions.get(type)
		if (!definition && strictDefinitions) throw new Error('EVENTS_DEFINITION_UNKNOWN')
		const parsedInput = definition ? definition.schema.parse(payload) : payload
		if (isolateUnexpectedThenable(parsedInput)) throw new Error('EVENTS_PAYLOAD_INVALID')
		const parsed = snapshotJson(parsedInput, 1_000_000)
		const timestamp = now()
		const rawOptions = input === undefined ? {} : safeObject(input, 'EVENTS_OPTIONS_INVALID') as EventPublishOptions
		const optionHeaders = rawOptions.headers === undefined
			? Object.freeze(Object.create(null)) as Readonly<Record<string, JsonValue>>
			: snapshotJson(rawOptions.headers, 16_384) as Readonly<Record<string, JsonValue>>
		if (!optionHeaders || Array.isArray(optionHeaders) || typeof optionHeaders !== 'object') throw new Error('EVENTS_HEADERS_INVALID')
		const headersInput = Object.assign(Object.create(null) as Record<string, JsonValue>, definition?.defaultHeaders, optionHeaders)
		if (Object.keys(headersInput).length > 32) throw new Error('EVENTS_HEADERS_LIMIT')
		const headers = snapshotJson(headersInput, 16_384) as Readonly<Record<string, JsonValue>>
		const subject = optionalString(rawOptions.subject, 256, 'EVENTS_OPTIONS_INVALID')
		const aggregateId = optionalString(rawOptions.aggregateId, 256, 'EVENTS_OPTIONS_INVALID')
		const partitionKey = optionalString(rawOptions.partitionKey, 256, 'EVENTS_OPTIONS_INVALID')
		const correlationId = optionalString(rawOptions.correlationId, 128, 'EVENTS_OPTIONS_INVALID')
		const causationId = optionalString(rawOptions.causationId, 128, 'EVENTS_OPTIONS_INVALID')
		const tenantId = optionalString(rawOptions.tenantId, 128, 'EVENTS_OPTIONS_INVALID')
		const availableAt = timestampOption(rawOptions.availableAt, timestamp)
		const expiresAt = rawOptions.expiresAt === undefined ? undefined : timestampOption(rawOptions.expiresAt, timestamp)
		if (!Number.isFinite(availableAt) || (expiresAt !== undefined
			&& (!Number.isFinite(expiresAt) || expiresAt <= timestamp || expiresAt <= availableAt))) {
			throw new Error('EVENTS_TIME_INVALID')
		}
		const envelope = freeze({id: randomUUID(), type, specVersion: '1.0' as const, source: definition?.source ?? 'ooops.events',
			...(subject ? {subject} : {}), ...(definition?.aggregateType ? {aggregateType: definition.aggregateType} : {}),
			...(aggregateId ? {aggregateId} : {}), ...(partitionKey ? {partitionKey} : {}), ...(correlationId ? {correlationId} : {}),
			...(causationId ? {causationId} : {}), ...(tenantId ? {tenantId} : {}),
			occurredAt: iso(timestamp), ...(availableAt > timestamp ? {availableAt: iso(availableAt)} : {}), ...(expiresAt !== undefined ? {expiresAt: iso(expiresAt)} : {}), headers, payload: parsed}) as EventEnvelope<T>
		let traceContext: StoredEventRecord['traceContext']
		try {
			const candidate = attached?.traceContext?.()
			if (isolateUnexpectedThenable(candidate)) throw new Error('EVENTS_TRACE_CONTEXT_INVALID')
			if (candidate !== undefined) {
				const raw = safeObject(candidate, 'EVENTS_TRACE_CONTEXT_INVALID', 3)
				const traceparent = optionalString(raw.traceparent, 256, 'EVENTS_TRACE_CONTEXT_INVALID')
				const tracestate = optionalString(raw.tracestate, 1_024, 'EVENTS_TRACE_CONTEXT_INVALID')
				const baggage = optionalString(raw.baggage, 8_192, 'EVENTS_TRACE_CONTEXT_INVALID')
				if (!traceparent || !/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/iu.test(traceparent)) {
					throw new Error('EVENTS_TRACE_CONTEXT_INVALID')
				}
				traceContext = freeze({traceparent, ...(tracestate ? {tracestate} : {}), ...(baggage ? {baggage} : {})})
			}
		} catch(error) { isolateUnexpectedThenable(error); traceContext = undefined }
		return {envelope, record: freeze({envelope, ...(definition ? {payloadValidated: true as const} : {}), ...(definition?.binding ? {binding: definition.binding} : {}), ...(traceContext ? {traceContext} : {}), status: 'queued' as const,
			attempts: 0, availableAt, ...(expiresAt !== undefined ? {expiresAt} : {}), createdAt: timestamp, updatedAt: timestamp})}
	}
	const runConsumer = async(consumer: Consumer, record: StoredEventRecord, controller: AbortController): Promise<void> => {
		const signal = controller.signal
		const inboxOwner = `${owner}:${randomUUID()}`
		const maximum = consumer.definition.concurrency!
		if (consumer.active >= maximum) await new Promise<void>((resolve) => consumer.waiters.push(resolve))
		else consumer.active++
		const release = (): void => {
			const next = consumer.waiters.shift()
			if (next) next()
			else consumer.active--
		}
		try {
			if (signal.aborted) throw Object.assign(new Error('EVENTS_CONSUMER_ABORTED'), {code: 'EVENTS_CONSUMER_ABORTED'})
			const consumerInbox = inbox
			let inboxClaimed = false
			if (consumerInbox) {
				while (!inboxClaimed) {
					const claimNow = now()
					const claim = await backendCall(consumerInbox.claim({
						consumer: consumer.definition.name,
						eventId: record.envelope.id,
						owner: inboxOwner,
						now: claimNow,
						expiresAt: claimNow + 30_000
					}))
					if (!['claimed', 'duplicate', 'busy'].includes(claim)) throw new Error(BACKEND_RESULT_INVALID)
					if (claim === 'duplicate') { emit({kind: 'consumed', result: 'duplicate'}); return }
					if (claim === 'busy') {
						try { await wait(250, undefined, {signal}) }
						catch(error) {
							isolateUnexpectedThenable(error)
							throw Object.assign(new Error('EVENTS_CONSUMER_ABORTED'), {code: 'EVENTS_CONSUMER_ABORTED'})
						}
						continue
					}
					inboxClaimed = true
				}
			}
			let renewal: Promise<void> | undefined
			let renewalError: unknown
			const renewalTimer = consumerInbox ? setInterval(() => {
				if (signal.aborted) return clearInterval(renewalTimer!)
				if (renewal) return
				renewal = fenceLease(Promise.resolve().then(() => backendBoolean(consumerInbox.renew({
					consumer: consumer.definition.name,
					eventId: record.envelope.id,
					owner: inboxOwner,
					expiresAt: now() + 30_000
				}))), controller, (error) => { renewalError = error }).then((renewed) => {
					if (!renewed) {
						renewalError = Object.assign(new Error('EVENTS_INBOX_LEASE_LOST'), {code: 'EVENTS_INBOX_LEASE_LOST'})
						controller.abort(renewalError)
					}
				}).catch((error: unknown) => { isolateUnexpectedThenable(error); renewalError = error; controller.abort(error) }).finally(() => { renewal = undefined })
			}, 10_000) : undefined
			const invoke = async(): Promise<void> => {
				if (signal.aborted) throw Object.assign(new Error('EVENTS_CONSUMER_ABORTED'), {code: 'EVENTS_CONSUMER_ABORTED'})
				const result = await consumer.handler(record.envelope, {consumer: consumer.definition.name, attempt: record.attempts, transport: 'local', receivedAt: iso(now()), signal})
				if (result === undefined) return
				const consumerResult = safeObject(result, 'EVENTS_CONSUMER_RESULT_INVALID', 2)
				if (!['processed', 'duplicate', 'failed'].includes(consumerResult.outcome as string)) {
					throw Object.assign(new Error('EVENTS_CONSUMER_RESULT_INVALID'), {code: 'EVENTS_CONSUMER_RESULT_INVALID'})
				}
				if (consumerResult.outcome === 'failed') {
					const code = consumerResult.failureCode === undefined
						? 'EVENTS_CONSUMER_FAILURE'
						: optionalString(consumerResult.failureCode, 128, 'EVENTS_CONSUMER_RESULT_INVALID')
					if (!code || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(code)) {
						throw Object.assign(new Error('EVENTS_CONSUMER_RESULT_INVALID'), {code: 'EVENTS_CONSUMER_RESULT_INVALID'})
					}
					throw Object.assign(new Error('EVENTS_CONSUMER_FAILURE'), {code})
				}
			}
			const observedInvoke = (): Promise<void> => attached?.withConsume
				? observeOnce((work) => attached!.withConsume!(work), invoke)
				: invoke()
			try {
				await (record.traceContext && attached?.withExtracted
					? observeOnce((work) => attached!.withExtracted!({...record.traceContext!}, work), observedInvoke)
					: observedInvoke())
				if (renewal) await renewal
				if (renewalError) throw renewalError
				if (consumerInbox && !await backendBoolean(consumerInbox.complete({
					consumer: consumer.definition.name, eventId: record.envelope.id, owner: inboxOwner
				}))) {
					throw Object.assign(new Error('EVENTS_INBOX_LEASE_LOST'), {code: 'EVENTS_INBOX_LEASE_LOST'})
				}
				inboxClaimed = false
				emit({kind: 'consumed', result: 'success'})
			}
			catch(error) {
				isolateUnexpectedThenable(error)
				if (consumerInbox && inboxClaimed) {
					const released = await backendBoolean(consumerInbox.release({
						consumer: consumer.definition.name,
						eventId: record.envelope.id,
						owner: inboxOwner
					}))
					if (!released) throw Object.assign(new Error('EVENTS_INBOX_LEASE_LOST'), {code: 'EVENTS_INBOX_LEASE_LOST'})
				}
				emit({kind: 'consumed', result: 'failure'})
				throw error
			}
			finally {
				if (renewalTimer) clearInterval(renewalTimer)
				if (renewal) await renewal
			}
		}
		finally { release() }
	}
	const processRecord = async(inputRecord: StoredEventRecord, claimedAt: number): Promise<void> => {
		let record: StoredEventRecord
		let rawRecord: Record<string, unknown> | undefined
		let rawEnvelope: Record<string, unknown> | undefined
		try {
			rawRecord = safeObject(inputRecord, 'EVENTS_RECORD_INVALID', 24)
			rawEnvelope = safeObject(rawRecord.envelope, 'EVENTS_ENVELOPE_INVALID', 32)
			const envelopeType = optionalString(rawEnvelope.type, 160, 'EVENTS_ENVELOPE_INVALID')
			const definition = definitions.get(envelopeType!)
			if (!definition && strictDefinitions) throw new Error('EVENTS_DEFINITION_UNKNOWN')
			if (!optionalString(rawEnvelope.id, 128, 'EVENTS_ENVELOPE_INVALID') || !envelopeType
				|| rawEnvelope.specVersion !== '1.0' || !optionalString(rawEnvelope.source, 256, 'EVENTS_ENVELOPE_INVALID')
				|| typeof rawEnvelope.occurredAt !== 'string' || !Number.isFinite(Date.parse(rawEnvelope.occurredAt))) {
				throw new Error('EVENTS_ENVELOPE_INVALID')
			}
			if (rawRecord.payloadValidated !== undefined && rawRecord.payloadValidated !== true) throw new Error('EVENTS_RECORD_INVALID')
			const payload = snapshotJson(
				definition && rawRecord.payloadValidated !== true ? definition.schema.parse(rawEnvelope.payload) : rawEnvelope.payload,
				1_000_000
			)
			const headers = snapshotJson(rawEnvelope.headers, 16_384) as Readonly<Record<string, JsonValue>>
			if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('EVENTS_ENVELOPE_INVALID')
			if (!Number.isSafeInteger(rawRecord.attempts) || (rawRecord.attempts as number) < 0 || (rawRecord.attempts as number) > 1_000_000
				|| typeof rawRecord.availableAt !== 'number' || !Number.isFinite(rawRecord.availableAt)
				|| typeof rawRecord.createdAt !== 'number' || !Number.isFinite(rawRecord.createdAt)
				|| typeof rawRecord.updatedAt !== 'number' || !Number.isFinite(rawRecord.updatedAt)) throw new Error('EVENTS_RECORD_INVALID')
			if (!['queued', 'dispatching', 'dispatched', 'failed', 'dead', 'cancelled'].includes(rawRecord.status as string)) {
				throw new Error('EVENTS_RECORD_INVALID')
			}
			const bindingInput = rawRecord.binding === undefined ? undefined : safeObject(rawRecord.binding, 'EVENTS_RECORD_INVALID', 3)
			const binding = bindingInput ? freeze({
				destination: optionalString(bindingInput.destination, 128, 'EVENTS_RECORD_INVALID'),
				target: optionalString(bindingInput.target, 2_048, 'EVENTS_RECORD_INVALID'),
				...(bindingInput.options === undefined ? {} : {options: snapshotJson(bindingInput.options, 16_384)})
			}) : undefined
			const traceInput = rawRecord.traceContext === undefined
				? undefined
				: safeObject(rawRecord.traceContext, 'EVENTS_RECORD_INVALID', 3)
			const traceContext = traceInput ? freeze({
				traceparent: optionalString(traceInput.traceparent, 256, 'EVENTS_RECORD_INVALID'),
				...(traceInput.tracestate === undefined ? {} : {
					tracestate: optionalString(traceInput.tracestate, 1_024, 'EVENTS_RECORD_INVALID')
				}),
				...(traceInput.baggage === undefined ? {} : {
					baggage: optionalString(traceInput.baggage, 8_192, 'EVENTS_RECORD_INVALID')
				})
			}) : undefined
			const leaseInput = rawRecord.lease === undefined ? undefined : safeObject(rawRecord.lease, 'EVENTS_RECORD_INVALID', 3)
			if (leaseInput && (typeof leaseInput.expiresAt !== 'number' || !Number.isFinite(leaseInput.expiresAt)
				|| typeof leaseInput.generation !== 'number' || !Number.isSafeInteger(leaseInput.generation)
				|| leaseInput.generation < 1)) throw new Error('EVENTS_RECORD_INVALID')
			const lease = leaseInput ? freeze({
				owner: optionalString(leaseInput.owner, 256, 'EVENTS_RECORD_INVALID'),
				expiresAt: leaseInput.expiresAt as number,
				generation: leaseInput.generation as number
			}) : undefined
			if (rawRecord.expiresAt !== undefined && (typeof rawRecord.expiresAt !== 'number' || !Number.isFinite(rawRecord.expiresAt))) {
				throw new Error('EVENTS_RECORD_INVALID')
			}
			if (typeof rawRecord.expiresAt === 'number' && rawRecord.expiresAt <= (rawRecord.availableAt as number)) {
				throw new Error('EVENTS_TIME_INVALID')
			}
			record = freeze({
				envelope: {...rawEnvelope, headers, payload},
				...(rawRecord.payloadValidated === true ? {payloadValidated: true as const} : {}),
				...(binding ? {binding} : {}),
				...(traceContext ? {traceContext} : {}),
				status: rawRecord.status,
				attempts: rawRecord.attempts,
				availableAt: rawRecord.availableAt,
				...(rawRecord.expiresAt === undefined ? {} : {expiresAt: rawRecord.expiresAt}),
				createdAt: rawRecord.createdAt,
				updatedAt: rawRecord.updatedAt,
				...(lease ? {lease} : {}),
				...(typeof rawRecord.failureCode === 'string' ? {failureCode: rawRecord.failureCode.slice(0, 128)} : {})
			}) as unknown as StoredEventRecord
		}
		catch(error) {
			const code = failureCode(error, 'EVENTS_ENVELOPE_INVALID')
			if (!rawRecord || !rawEnvelope) throw error
			const lease = safeObject(rawRecord.lease, 'EVENTS_RECORD_INVALID', 3)
			if (typeof rawEnvelope.id !== 'string' || typeof lease.generation !== 'number' || !Number.isSafeInteger(lease.generation)) throw error
			const updated = await backendBoolean(outbox.deadLetter(
				rawEnvelope.id,
				owner,
				lease.generation,
				code
			))
			if (!updated) throw Object.assign(new Error(OUTBOX_LEASE_LOST), {code: OUTBOX_LEASE_LOST})
			deadLetteredTotal++
			emit({kind: 'delivered', result: 'failure', transport: 'local'})
			return
		}
		if (record.status !== 'dispatching' || !record.lease || record.lease.owner !== owner
			|| record.lease.expiresAt < claimedAt + 30_000) {
			throw new Error(BACKEND_RESULT_INVALID)
		}
		const controller = createSafeAbortController(); controllers.add(controller)
		let renewal: Promise<void> | undefined
		let leaseLost = false
		let renewalError: unknown
		const renewalTimer = setInterval(() => {
			if (controller.signal.aborted) return clearInterval(renewalTimer!)
			if (renewal) return
			renewal = fenceLease(Promise.resolve().then(() => backendBoolean(outbox.renew(
				record.envelope.id,
				owner,
				record.lease!.generation,
				now() + 30_000
			))), controller, (error) => { renewalError = error }).then((renewed) => {
				if (!renewed) {
					leaseLost = true
					controller.abort()
				}
			}).catch((error: unknown) => {
				isolateUnexpectedThenable(error)
				renewalError = error
				controller.abort()
			}).finally(() => { renewal = undefined })
		}, 10_000)
		try {
			const matchingConsumers = [...consumers.values()].filter((consumer) =>
				consumer.definition.eventTypes.includes(record.envelope.type))
			if (!record.binding && !matchingConsumers.length) {
				throw permanentFailure('EVENTS_DELIVERY_UNROUTED')
			}
			const consumerResults = await Promise.allSettled(
				matchingConsumers.map((consumer) => runConsumer(consumer, record, controller))
			)
			const consumerFailure = consumerResults.find((result) => result.status === 'rejected')
			if (consumerFailure?.status === 'rejected') throw consumerFailure.reason
			if (renewal) await renewal
			if (renewalError) throw renewalError
			if (leaseLost) throw Object.assign(new Error(OUTBOX_LEASE_LOST), {code: OUTBOX_LEASE_LOST})
			if (record.binding) {
				const destination = destinations.get(record.binding.destination)
				if (!destination) throw permanentFailure('EVENTS_DESTINATION_UNKNOWN')
				const physical = trackPhysical(Promise.resolve().then(() => destination.deliver(record.envelope, record.binding!, controller.signal)))
				let result: void | EventDeliveryResult
				try { result = await bounded(physical, operationTimeout, 'EVENTS_DELIVERY_TIMEOUT') }
				catch(error) {
					if (failureCode(error) !== 'EVENTS_DELIVERY_TIMEOUT') throw error
					controller.abort(error)
					result = await physical
				}
				let deliveryResult: Record<string, unknown> | undefined
				if (result !== undefined) {
					deliveryResult = safeObject(result, 'EVENTS_DELIVERY_RESULT_INVALID', 2)
					if (!['success', 'retryable', 'permanent-failure'].includes(deliveryResult.status as string)
						|| (deliveryResult.retryAfterMs !== undefined && (!Number.isSafeInteger(deliveryResult.retryAfterMs)
							|| (deliveryResult.retryAfterMs as number) < 0 || (deliveryResult.retryAfterMs as number) > 120_000))) {
						throw new Error('EVENTS_DELIVERY_RESULT_INVALID')
					}
				}
				if (deliveryResult?.status === 'retryable') throw Object.assign(new Error('EVENTS_DELIVERY_RETRY'), {code: 'EVENTS_DELIVERY_RETRY', retryAfterMs: deliveryResult.retryAfterMs})
				if (deliveryResult?.status === 'permanent-failure') throw permanentFailure('EVENTS_DELIVERY_PERMANENT')
				emit({kind: 'delivered', result: 'success', transport: destination.kind})
			}
			if (renewal) await renewal
			if (renewalError) throw renewalError
			if (leaseLost) throw Object.assign(new Error(OUTBOX_LEASE_LOST), {code: OUTBOX_LEASE_LOST})
			if (record.lease && !await backendBoolean(outbox.complete(record.envelope.id, owner, record.lease.generation))) {
				throw Object.assign(new Error(OUTBOX_LEASE_LOST), {code: OUTBOX_LEASE_LOST})
			}
			backendState = 'healthy'
			lastFailureCode = undefined
		} catch(error) {
			const code = failureCode(error, 'EVENTS_DELIVERY_FAILURE')
			const permanent = dataProperty(error, 'permanent') === true
			if (!record.lease) throw error
			if (permanent || record.attempts >= maxAttempts) {
				const updated = await backendBoolean(outbox.deadLetter(record.envelope.id, owner, record.lease.generation, code))
				if (!updated) throw Object.assign(new Error(OUTBOX_LEASE_LOST), {code: OUTBOX_LEASE_LOST})
				deadLetteredTotal++
				backendState = 'unhealthy'
				lastFailureCode = code
				emit({kind: 'delivered', result: 'failure', transport: record.binding ? (destinations.get(record.binding.destination)?.kind ?? 'custom') : 'local'})
			} else {
				const retryAfter = Number(dataProperty(error, 'retryAfterMs')) || 0
				const backoff = Math.min(60_000, Math.max(retryAfter || 0, 250 * (2 ** Math.min(8, record.attempts - 1))))
				const updated = await backendBoolean(outbox.retry(record.envelope.id, owner, record.lease.generation, now() + backoff, code))
				if (!updated) throw Object.assign(new Error(OUTBOX_LEASE_LOST), {code: OUTBOX_LEASE_LOST})
				retriedTotal++
				backendState = 'degraded'
				lastFailureCode = code
				emit({kind: 'retry'})
			}
		} finally {
			if (renewalTimer) clearInterval(renewalTimer)
			if (renewal) await renewal
			controllers.delete(controller)
		}
	}
	let claiming = false
	let dispatchSlots = 0
	const dispatchWork = async(): Promise<void> => {
		if (!worker || state !== 'running' || claiming || dispatchSlots >= maxConcurrent) return
		claiming = true
		const work: Promise<void>[] = []
		try {
			const capacity = maxConcurrent - dispatchSlots
			const claimedAt = now()
			const claimed = await backendCall(outbox.claimDue({now: claimedAt, limit: capacity, owner, leaseMs: 30_000}))
			const records = snapshotArray(claimed, capacity, BACKEND_RESULT_INVALID) as StoredEventRecord[]
			const claimedIds = new Set<string>()
			for (const item of records) {
				let id: unknown
				try { id = safeObject(safeObject(item, BACKEND_RESULT_INVALID, 24).envelope, BACKEND_RESULT_INVALID, 32).id } catch { continue }
				if (typeof id === 'string' && claimedIds.has(id)) throw new Error(BACKEND_RESULT_INVALID)
				if (typeof id === 'string') claimedIds.add(id)
			}
			for (const record of records) {
				dispatchSlots++
				work.push(own(processRecord(record, claimedAt)).finally(() => { dispatchSlots-- }))
			}
		} finally { claiming = false }
		const results = await Promise.allSettled(work)
		try {
			const failure = results.find((result) => result.status === 'rejected')
			if (failure?.status === 'rejected') throw failure.reason
			const count = await backendCall(outbox.queuedCount())
			if (!Number.isSafeInteger(count) || count < 0) throw new Error(BACKEND_RESULT_INVALID)
			queuedEvents = count; emit({kind: 'queue', size: queuedEvents})
		} catch(error) { isolateUnexpectedThenable(error); throw error }
	}
	const dispatch = (): Promise<void> => runLifecycle('operation', dispatchWork)
	const snapshotInboundEnvelope = (input: unknown): {
		envelope: EventEnvelope<unknown>
		availableAt?: number
		expiresAt?: number
		traceContext?: StoredEventRecord['traceContext']
	} => {
		const raw = safeObject(input, 'EVENTS_ENVELOPE_INVALID', 32)
		const id = optionalString(raw.id, 128, 'EVENTS_ENVELOPE_INVALID')
		const type = optionalString(raw.type, 160, 'EVENTS_ENVELOPE_INVALID')
		const source = optionalString(raw.source, 256, 'EVENTS_ENVELOPE_INVALID')
		if (!id || !type || !source || raw.specVersion !== '1.0' || typeof raw.occurredAt !== 'string'
			|| !Number.isFinite(Date.parse(raw.occurredAt))) throw new Error('EVENTS_ENVELOPE_INVALID')
		if (strictDefinitions && !definitions.has(type)) throw new Error('EVENTS_DEFINITION_UNKNOWN')
		const definition = definitions.get(type)
		const headers = snapshotJson(raw.headers, 16_384) as Readonly<Record<string, JsonValue>>
		if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('EVENTS_ENVELOPE_INVALID')
		const payload = snapshotJson(definition ? definition.schema.parse(raw.payload) : raw.payload, 1_000_000)
		const optional = (name: string, maximum: number): string | undefined => optionalString(raw[name], maximum, 'EVENTS_ENVELOPE_INVALID')
		const availableAt = optional('availableAt', 64)
		const expiresAt = optional('expiresAt', 64)
		const availableAtMs = availableAt ? Date.parse(availableAt) : undefined
		const expiresAtMs = expiresAt ? Date.parse(expiresAt) : undefined
		if ((availableAtMs !== undefined && !Number.isFinite(availableAtMs)) || (expiresAtMs !== undefined
			&& (!Number.isFinite(expiresAtMs) || (availableAtMs !== undefined && expiresAtMs <= availableAtMs)))) {
			throw new Error('EVENTS_ENVELOPE_INVALID')
		}
		const envelope = freeze({id, type, specVersion: '1.0' as const, source,
			...(optional('subject', 256) ? {subject: optional('subject', 256)} : {}),
			...(optional('aggregateType', 160) ? {aggregateType: optional('aggregateType', 160)} : {}),
			...(optional('aggregateId', 256) ? {aggregateId: optional('aggregateId', 256)} : {}),
			...(optional('partitionKey', 256) ? {partitionKey: optional('partitionKey', 256)} : {}),
			...(optional('correlationId', 128) ? {correlationId: optional('correlationId', 128)} : {}),
			...(optional('causationId', 128) ? {causationId: optional('causationId', 128)} : {}),
			...(optional('tenantId', 128) ? {tenantId: optional('tenantId', 128)} : {}),
			occurredAt: raw.occurredAt, ...(availableAt ? {availableAt} : {}), ...(expiresAt ? {expiresAt} : {}), headers, payload
		}) as EventEnvelope<unknown>
		const traceparent = optionalString(raw.traceparent, 256, 'EVENTS_ENVELOPE_INVALID')
		const tracestate = optionalString(raw.tracestate, 1_024, 'EVENTS_ENVELOPE_INVALID')
		const baggage = optionalString(raw.baggage, 8_192, 'EVENTS_ENVELOPE_INVALID')
		return {envelope, ...(availableAtMs === undefined ? {} : {availableAt: availableAtMs}),
			...(expiresAtMs === undefined ? {} : {expiresAt: expiresAtMs}),
			...(traceparent ? {traceContext: freeze({traceparent, ...(tracestate ? {tracestate} : {}), ...(baggage ? {baggage} : {})})} : {})}
	}
	const events: ManagedEvents = {
		registerDefinition(definition): void {
			if (state !== 'idle' || registrationClosed) throw new Error('EVENTS_REGISTRATION_CLOSED')
			if (definitions.size >= 1_000) throw new Error('EVENTS_DEFINITION_LIMIT')
			isolateInputFields(definition, [
				'type', 'source', 'summary', 'description', 'aggregateType', 'schema', 'binding', 'defaultHeaders', 'version', 'tags'
			])
			isolateCapabilityFields(dataProperty(definition, 'schema'), ['parse'])
			const preflightBinding = dataProperty(definition, 'binding')
			isolateInputFields(preflightBinding, ['destination', 'target', 'options'])
			isolateJsonThenables(dataProperty(preflightBinding, 'options'))
			isolateJsonThenables(dataProperty(definition, 'defaultHeaders'))
			isolateArrayItemFields(dataProperty(definition, 'tags'), [], 32)
			const input = safeObject(definition, 'EVENTS_DEFINITION_INVALID')
			const type = optionalString(input.type, 160, 'EVENTS_DEFINITION_INVALID')
			const source = optionalString(input.source, 256, 'EVENTS_DEFINITION_INVALID')
			if (!type || !source || definitions.has(type) || !input.schema || typeof input.schema !== 'object') {
				throw new Error('EVENTS_DEFINITION_INVALID')
			}
			const parse = captureMethod(input.schema as EventDefinition['schema'], 'parse')
			const bindingInput = input.binding === undefined ? undefined : safeObject(input.binding, 'EVENTS_DEFINITION_INVALID', 3)
			const bindingDestination = bindingInput
				? optionalString(bindingInput.destination, 128, 'EVENTS_DEFINITION_INVALID')
				: undefined
			const bindingTarget = bindingInput ? optionalString(bindingInput.target, 2_048, 'EVENTS_DEFINITION_INVALID') : undefined
			if (bindingInput && (!bindingDestination || !bindingTarget)) throw new Error('EVENTS_DEFINITION_INVALID')
			const bindingOptions = bindingInput?.options === undefined ? undefined : snapshotJson(bindingInput.options, 16_384)
			if (bindingOptions !== undefined && (!bindingOptions || Array.isArray(bindingOptions)
				|| typeof bindingOptions !== 'object')) throw new Error('EVENTS_DEFINITION_INVALID')
			const binding = bindingInput ? freeze({
				destination: bindingDestination!,
				target: bindingTarget!,
				...(bindingOptions === undefined ? {} : {options: bindingOptions as Readonly<Record<string, JsonValue>>})
			}) : undefined
			if (binding && !destinations.has(binding.destination)) throw new Error('EVENTS_DESTINATION_UNKNOWN')
			const defaultHeaders = input.defaultHeaders === undefined
				? undefined
				: snapshotJson(input.defaultHeaders, 16_384) as Readonly<Record<string, JsonValue>>
			if (defaultHeaders !== undefined && (!defaultHeaders || Array.isArray(defaultHeaders) || typeof defaultHeaders !== 'object'
				|| Object.keys(defaultHeaders).length > 32)) throw new Error('EVENTS_DEFINITION_INVALID')
			const tagInput = input.tags === undefined ? undefined : snapshotArray(input.tags, 32, 'EVENTS_DEFINITION_INVALID')
			const tags = tagInput?.map((tag) => optionalString(tag, 64, 'EVENTS_DEFINITION_INVALID')!)
			definitions.set(type, Object.freeze({type, source, schema: Object.freeze({parse}),
				...(input.summary === undefined ? {} : {summary: optionalString(input.summary, 256, 'EVENTS_DEFINITION_INVALID')!}),
				...(input.description === undefined ? {} : {description: optionalString(input.description, 2_048, 'EVENTS_DEFINITION_INVALID')!}),
				...(input.aggregateType === undefined ? {} : {aggregateType: optionalString(input.aggregateType, 160, 'EVENTS_DEFINITION_INVALID')!}),
				...(binding ? {binding} : {}), ...(defaultHeaders ? {defaultHeaders} : {}),
				...(input.version === undefined ? {} : {version: optionalString(input.version, 64, 'EVENTS_DEFINITION_INVALID')!}),
				...(tags ? {tags: Object.freeze(tags)} : {})}))
		},
		registerConsumer<TPayload = unknown>(definition: EventConsumerDefinition, handler: EventConsumerHandler<TPayload>): LifecycleHookDisposer {
			if (state !== 'idle' || registrationClosed) throw new Error('EVENTS_REGISTRATION_CLOSED')
			if (consumers.size >= 256) throw new Error('EVENTS_CONSUMER_LIMIT')
			isolateInputFields(definition, ['name', 'eventTypes', 'concurrency'])
			isolateArrayItemFields(dataProperty(definition, 'eventTypes'), [], 64)
			isolateUnexpectedThenable(handler)
			const input = safeObject(definition, 'EVENTS_CONSUMER_INVALID')
			const name = optionalString(input.name, 128, 'EVENTS_CONSUMER_INVALID')
			const eventTypes = snapshotArray(input.eventTypes, 64, 'EVENTS_CONSUMER_INVALID')
				.map((type) => optionalString(type, 160, 'EVENTS_CONSUMER_INVALID')!)
			if (!name || consumers.has(name) || !eventTypes.length || new Set(eventTypes).size !== eventTypes.length
				|| typeof handler !== 'function') throw new Error('EVENTS_CONSUMER_INVALID')
			const concurrency = input.concurrency === undefined ? 1 : input.concurrency
			if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
				throw new Error('EVENTS_CONSUMER_INVALID')
			}
			const normalized = Object.freeze({name, eventTypes: Object.freeze(eventTypes), concurrency})
			consumers.set(name, {definition: normalized, handler: handler as EventConsumerHandler, active: 0, waiters: []}); let disposed = false
			return () => { if (!disposed && state === 'idle') consumers.delete(name); disposed = true }
		},
		async publish<T>(type: string, payload: T, publishOptions?: EventPublishOptions): Promise<EventEnvelope<T>> {
			const operation = async(): Promise<EventEnvelope<T>> => {
				const {envelope, record} = build(type, payload, publishOptions)
				try { await own(backendCall(outbox.append([record]))); queuedEvents++; emit({kind: 'published', result: 'success', event: envelope}); emit({kind: 'queue', size: queuedEvents}); if (inline && state === 'running') await own(dispatch()); return envelope }
				catch(error) { isolateUnexpectedThenable(error); emit({kind: 'published', result: 'failure'}); throw error }
			}
			return runLifecycle('operation', () =>
				attached?.withPublish ? observeOnce((work) => attached!.withPublish!(work), operation) : operation())
		},
		async publishMany(requests: readonly EventPublishRequest[]): Promise<readonly EventEnvelope[]> {
			const operation = async(): Promise<readonly EventEnvelope[]> => {
				const inputRequests = snapshotArray(requests, 1_000, 'EVENTS_BATCH_INVALID')
				for (const request of inputRequests) {
					isolateInputFields(request, ['type', 'payload', 'options'])
					isolateJsonThenables(dataProperty(request, 'payload'))
					const requestOptions = dataProperty(request, 'options')
					isolateInputFields(requestOptions, [
						'headers', 'subject', 'aggregateId', 'partitionKey', 'correlationId', 'causationId', 'tenantId',
						'availableAt', 'expiresAt'
					])
					isolateJsonThenables(dataProperty(requestOptions, 'headers'))
				}
				const built: Array<{envelope: EventEnvelope; record: StoredEventRecord}> = []
				let batchBytes = 0
				for (const request of inputRequests) {
					const input = safeObject(request, 'EVENTS_BATCH_INVALID', 3)
					const entry = build(
						input.type as string,
						input.payload,
						input.options as EventPublishOptions | undefined
					) as {envelope: EventEnvelope; record: StoredEventRecord}
					batchBytes += Buffer.byteLength(JSON.stringify(entry.record))
					if (batchBytes > 8_000_000) throw new Error('EVENTS_BATCH_LIMIT')
					built.push(entry)
				}
				await own(backendCall(outbox.append(built.map((entry) => entry.record)))); queuedEvents += built.length
				for (const entry of built) emit({kind: 'published', result: 'success', event: entry.envelope})
				if (inline && state === 'running') await own(dispatch()); return built.map((entry) => entry.envelope)
			}
			return runLifecycle('operation', () =>
				attached?.withPublish ? observeOnce((work) => attached!.withPublish!(work), operation) : operation())
		},
		async start(): Promise<void> {
			if (state === 'running') return; if (state !== 'idle') throw new Error('EVENTS_START_INVALID_STATE')
			if (startFlight) return lifecycleReentry.getStore()?.active && lifecycleReentry.getStore()?.kind === 'start' ? undefined : startFlight
			registrationClosed = true
			let beginStart!: () => void
			const gate = new Promise<void>((resolve) => { beginStart = resolve })
			startFlight = gate.then(() => runLifecycle('start', async() => {
				if (worker) for (const destination of destinationList) {
					if (!destination.startConsumer) continue
					const physicalStart = trackPhysical(Promise.resolve().then(() => destination.startConsumer!(async(inputEnvelope) => runLifecycle('operation', async() => {
						if (state === 'draining' || state === 'closed') throw new Error('EVENTS_ADMISSION_CLOSED')
						if (inboundActive >= maxConcurrent) throw new Error('EVENTS_INGRESS_BUSY')
						inboundActive++
						try {
							const timestamp = now()
							let record: StoredEventRecord
							try {
								const {envelope, availableAt, expiresAt, traceContext} = snapshotInboundEnvelope(inputEnvelope)
								record = freeze({envelope, ...(definitions.has(envelope.type) ? {payloadValidated: true as const} : {}), status: 'queued', attempts: 0, availableAt: availableAt ?? timestamp,
									...(expiresAt === undefined ? {} : {expiresAt}), createdAt: timestamp, updatedAt: timestamp,
									...(traceContext ? {traceContext} : {})})
							} catch(error) {
								const message = dataProperty(error, 'message')
								throw Object.assign(permanentFailure(typeof message === 'string' && /^EVENTS_[A-Z0-9_]{1,120}$/u.test(message)
									? message : failureCode(error, 'EVENTS_INGRESS_INVALID')), {ingress: true})
							}
							await backendCall(outbox.append([record]))
						} finally { inboundActive-- }
					}))))
					const stop = await extensionCall(physicalStart, 'EVENTS_TRANSPORT_START_TIMEOUT')
					if (typeof stop !== 'function') throw new Error(EXTENSION_INVALID)
					destinationStops.push(stop)
				}
				if (state !== 'idle') throw new Error('EVENTS_START_INVALID_STATE')
				state = 'running'
				if (worker) {
					await own(dispatch())
					pollTimer = setInterval(() => { void own(dispatch()).catch((error: unknown) => { isolateUnexpectedThenable(error) }) }, pollInterval)
					pollTimer.unref()
				}
				maintenanceTimer = setInterval(() => {
					if (maintaining) return
					maintaining = true
					void Promise.resolve().then(() => runLifecycle('operation', () => backendCall(outbox.purgeExpired(now(), 1_000))))
						.catch((error: unknown) => { isolateUnexpectedThenable(error) }).finally(() => { maintaining = false })
				}, maintenanceInterval)
				maintenanceTimer.unref()
			})).catch(async(error) => {
				isolateUnexpectedThenable(error)
				let cleanupFailed = false
				for (const stop of [...destinationStops]) {
					try {
						await extensionCall(Promise.resolve().then(stop), 'EVENTS_TRANSPORT_SHUTDOWN_TIMEOUT')
						destinationStops.splice(destinationStops.indexOf(stop), 1)
					} catch(cleanup) { isolateUnexpectedThenable(cleanup); cleanupFailed = true }
				}
				if (state !== 'draining' && state !== 'closed') state = cleanupFailed ? 'draining' : 'idle'
				throw error
			})
			beginStart()
			try { await startFlight } finally { startFlight = undefined }
		},
		getStatus(): EventsStatus { return freeze({state, backendState: state === 'closed' ? 'closed' : backendState, activeOperations: active.size, queuedEvents, retriedTotal, deadLetteredTotal, ...(lastFailureCode ? {lastFailureCode} : {})}) },
		async flush(): Promise<void> {
			if (state === 'closed') return
			if (state === 'draining' && shutdownFlight) {
				return activeLifecycle() ? undefined : shutdownFlight
			}
			if (flushFlight) return activeLifecycle() ? undefined : flushFlight
			const internalCaller = activeLifecycle()
			const cutoff = [...active, ...physicalWork]
			let beginFlush!: () => void
			const gate = new Promise<void>((resolve) => { beginFlush = resolve })
			flushFlight = gate.then(() => runLifecycle('flush', async() => {
				await Promise.allSettled(cutoff)
				await extensionCall(Promise.resolve().then(() => outbox.flush?.()), 'EVENTS_FLUSH_TIMEOUT')
				await Promise.all(destinationList.map((destination) =>
					extensionCall(Promise.resolve().then(() => destination.flush?.()), 'EVENTS_FLUSH_TIMEOUT')))
			}))
			beginFlush()
			if (internalCaller) {
				void flushFlight.finally(() => { flushFlight = undefined }).catch(() => {})
				return
			}
			try { await flushFlight } finally { flushFlight = undefined }
		},
		async shutdown(): Promise<void> {
			if (state === 'closed') return
			if (shutdownFlight) return activeLifecycle() ? undefined : shutdownFlight
			const internalCaller = activeLifecycle()
			state = 'draining'
			let beginShutdown!: () => void
			const gate = new Promise<void>((resolve) => { beginShutdown = resolve })
			shutdownFlight = gate.then(() => runLifecycle('shutdown', async() => { try { if (startFlight) await bounded(Promise.allSettled([startFlight]).then(() => undefined), shutdownTimeout, 'EVENTS_SHUTDOWN_TIMEOUT'); if (flushFlight) await bounded(Promise.allSettled([flushFlight]).then(() => undefined), shutdownTimeout, 'EVENTS_SHUTDOWN_TIMEOUT'); await finalizeStep('drain', settleOwned, 'EVENTS_SHUTDOWN_TIMEOUT', shutdownTimeout); for (const [index, stop] of destinationStops.entries()) await finalizeStep(`subscription:${index}`, () => stop(), 'EVENTS_TRANSPORT_SHUTDOWN_TIMEOUT'); await finalizeStep('outbox:flush', () => outbox.flush?.(), 'EVENTS_FLUSH_TIMEOUT'); for (const [index, destination] of destinationList.entries()) { await finalizeStep(`destination:${index}:flush`, () => destination.flush?.(), 'EVENTS_FLUSH_TIMEOUT'); await finalizeStep(`destination:${index}:shutdown`, () => destination.shutdown?.(), 'EVENTS_TRANSPORT_SHUTDOWN_TIMEOUT') } await finalizeStep('inbox:flush', () => inbox?.flush?.(), 'EVENTS_FLUSH_TIMEOUT'); await finalizeStep('inbox:shutdown', () => inbox?.shutdown?.(), 'EVENTS_BACKEND_SHUTDOWN_TIMEOUT'); await finalizeStep('outbox:shutdown', () => outbox.shutdown?.(), 'EVENTS_BACKEND_SHUTDOWN_TIMEOUT'); for (const [index, dispose] of disposers.entries()) await finalizeStep(`lifecycle:dispose:${index}`, () => dispose(), 'EVENTS_FINALIZATION_TIMEOUT'); disposers.length = 0; state = 'closed'; backendState = 'closed'; lastFailureCode = undefined }
			catch(error) { backendState = 'unhealthy'; lastFailureCode = failureCode(error, 'EVENTS_FINALIZATION_FAILURE'); emit({kind: 'finalization-failure', operation: 'shutdown', error}); throw error } }))
			if (pollTimer) clearInterval(pollTimer)
			if (maintenanceTimer) clearInterval(maintenanceTimer)
			for (const controller of controllers) controller.abort()
			beginShutdown()
			if (internalCaller) {
				void shutdownFlight.finally(() => {
					if ((state as EventsStatus['state']) !== 'closed') shutdownFlight = undefined
				}).catch(() => {})
				return
			}
			try { await shutdownFlight } finally { if ((state as EventsStatus['state']) !== 'closed') shutdownFlight = undefined }
		}
	}
	registerEventsTelemetry(events, (value) => {
		if (attachmentUsed) throw new Error('EVENTS_OBSERVABILITY_ALREADY_ATTACHED')
		const emitTelemetry = captureMethod(value, 'emit')
		const traceContext = captureOptionalMethod(value, 'traceContext')
		const withExtracted = captureOptionalMethod(value, 'withExtracted')
		const withPublish = captureOptionalMethod(value, 'withPublish')
		const withConsume = captureOptionalMethod(value, 'withConsume')
		const captured: EventsTelemetryAttachment = Object.freeze({
			emit: emitTelemetry,
			...(traceContext ? {traceContext} : {}),
			...(withExtracted ? {withExtracted} : {}),
			...(withPublish ? {withPublish} : {}),
			...(withConsume ? {withConsume} : {})
		})
		attachmentUsed = true
		attached = captured
		let done = false
		return () => {
			if (done) return
			done = true
			if (attached === captured) attached = undefined
			attachmentUsed = false
		}
	})
	if (registerFlushHook && registerShutdownHook) {
		try {
			const flushDisposer = registerFlushHook('events', () => events.flush())
			if (typeof flushDisposer !== 'function') {
				isolateUnexpectedThenable(flushDisposer)
				throw new Error(EXTENSION_INVALID)
			}
			disposers.push(flushDisposer)
			const shutdownDisposer = registerShutdownHook('application', () => events.shutdown(), {name: 'events'})
			if (typeof shutdownDisposer !== 'function') {
				isolateUnexpectedThenable(shutdownDisposer)
				throw new Error(EXTENSION_INVALID)
			}
			disposers.push(shutdownDisposer)
		} catch(error) {
			isolateUnexpectedThenable(error)
			for (const dispose of disposers.splice(0).reverse()) {
				try { isolateUnexpectedThenable(dispose()) } catch(disposalError) { isolateUnexpectedThenable(disposalError) }
			}
			throw error
		}
		if (state !== 'idle') {
			if (shutdownFlight) await shutdownFlight
			throw new Error(EXTENSION_INVALID)
		}
	}
	const transactional: TransactionalEventsPort | undefined = transactionalStore ? {async publishTransactional(transaction, type, payload, publishOptions) { return runLifecycle('operation', async() => { const {envelope, record} = build(type, payload, publishOptions); await own(backendCall(transactionalStore.appendTransactional(transaction, [record]))); emit({kind: 'published', result: 'success', event: envelope}); return envelope }) }} : undefined
	const adminLimit = (value: unknown, fallback = 100): number => {
		const result = value ?? fallback
		if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > 1_000) {
			throw new Error('EVENTS_ADMIN_INPUT_INVALID')
		}
		return result as number
	}
	const adminId = (value: unknown): string => {
		if (typeof value !== 'string' || !value || value.length > 160) throw new Error('EVENTS_ADMIN_INPUT_INVALID')
		return value
	}
	const adminDate = (value: unknown): string => {
		if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
			throw new Error(BACKEND_RESULT_INVALID)
		}
		return value
	}
	const adminAttempts = (value: unknown): number => {
		if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
			throw new Error(BACKEND_RESULT_INVALID)
		}
		return value as number
	}
	const outboxSummary = (value: unknown): EventOutboxSummary => {
		const row = safeObject(value, BACKEND_RESULT_INVALID, 16)
		if (!['queued', 'dispatching', 'dispatched', 'failed', 'dead', 'cancelled'].includes(row.status as string)) {
			throw new Error(BACKEND_RESULT_INVALID)
		}
		return freeze({eventId: adminId(row.eventId), type: adminId(row.type), status: row.status as EventDeliveryStatus,
			attempts: adminAttempts(row.attempts), createdAt: adminDate(row.createdAt), updatedAt: adminDate(row.updatedAt),
			...(row.availableAt === undefined ? {} : {availableAt: adminDate(row.availableAt)}),
			...(row.failureCode === undefined ? {} : {failureCode: optionalString(row.failureCode, 128, BACKEND_RESULT_INVALID)})})
	}
	const deadLetterSummary = (value: unknown): EventDeadLetterSummary => {
		const row = safeObject(value, BACKEND_RESULT_INVALID, 12)
		return freeze({eventId: adminId(row.eventId), type: adminId(row.type), attempts: adminAttempts(row.attempts),
			failedAt: adminDate(row.failedAt), failureCode: optionalString(row.failureCode, 128, BACKEND_RESULT_INVALID)}) as EventDeadLetterSummary
	}
	const admin: EventsAdminPort | undefined = adminStore ? {
		async replay(request) {
			return runLifecycle('operation', async() => {
				const input = safeObject(request, 'EVENTS_ADMIN_INPUT_INVALID', 5)
				const limit = adminLimit(input.limit)
				const from = input.from === undefined ? undefined : optionalString(input.from, 64, 'EVENTS_ADMIN_INPUT_INVALID')
				const to = input.to === undefined ? undefined : optionalString(input.to, 64, 'EVENTS_ADMIN_INPUT_INVALID')
				if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))
					|| (from && to && Date.parse(from) > Date.parse(to))) throw new Error('EVENTS_ADMIN_INPUT_INVALID')
				const count = await backendCall(adminStore.replay({
					...(input.eventId === undefined ? {} : {eventId: adminId(input.eventId)}),
					...(input.type === undefined ? {} : {type: adminId(input.type)}),
					...(from ? {from} : {}), ...(to ? {to} : {}), limit
				}, now()))
				if (!Number.isSafeInteger(count) || count < 0 || count > limit) throw new Error(BACKEND_RESULT_INVALID)
				return count
			})
		},
		async retryDeadLetter(id) {
			return runLifecycle('operation', async() => {
				const result = await backendCall(adminStore.retryDeadLetter(adminId(id), now()))
				if (typeof result !== 'boolean') throw new Error(BACKEND_RESULT_INVALID)
				return result
			})
		},
		async cancelScheduled(id) {
			return runLifecycle('operation', async() => {
				const result = await backendCall(adminStore.cancelScheduled(adminId(id), now()))
				if (typeof result !== 'boolean') throw new Error(BACKEND_RESULT_INVALID)
				return result
			})
		},
		async listOutbox(options) {
			return runLifecycle('operation', async() => {
				const input = options === undefined ? {} : safeObject(options, 'EVENTS_ADMIN_INPUT_INVALID', 3)
				const limit = adminLimit(input.limit)
				const status = input.status
				if (status !== undefined && !['queued', 'dispatching', 'dispatched', 'failed', 'dead', 'cancelled'].includes(status as string)) throw new Error('EVENTS_ADMIN_INPUT_INVALID')
				const rows = await backendCall(adminStore.listOutbox({
					...(status === undefined ? {} : {status: status as EventDeliveryStatus}),
					...(input.type === undefined ? {} : {type: adminId(input.type)}), limit
				}))
				isolateArrayItemFields(rows, [
					'eventId', 'type', 'status', 'attempts', 'createdAt', 'updatedAt', 'availableAt', 'failureCode'
				], limit)
				return Object.freeze(snapshotArray(rows, limit, BACKEND_RESULT_INVALID).map(outboxSummary))
			})
		},
		async listDeadLetters(inputLimit) {
			return runLifecycle('operation', async() => {
				const limit = adminLimit(inputLimit)
				const rows = await backendCall(adminStore.listDeadLetters(limit))
				isolateArrayItemFields(rows, ['eventId', 'type', 'attempts', 'failedAt', 'failureCode'], limit)
				return Object.freeze(snapshotArray(rows, limit, BACKEND_RESULT_INVALID).map(deadLetterSummary))
			})
		},
		async purgeExpired() {
			return runLifecycle('operation', async() => {
				const count = await backendCall(adminStore.purgeExpired(now(), 1_000))
				if (!Number.isSafeInteger(count) || count < 0 || count > 1_000) throw new Error(BACKEND_RESULT_INVALID)
				return count
			})
		}
	} : undefined
	return {events, ...(transactional ? {transactional} : {}), ...(admin ? {admin} : {})}
}
