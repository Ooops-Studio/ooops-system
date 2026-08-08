import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {EventsRuntime} from '@ooopsstudio/core/ports/events'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createEventsManager, type EventsRole} from '../manager'
import {
	inputField, isolateArrayItemFields, isolateCapabilityFields, isolateEventsBackendInput, isolateInputFields
} from '../safe-input'
import type {EventDestination, EventsBackend} from '../types'

export interface CustomEventsOptions {
	readonly backend: EventsBackend
	readonly role: EventsRole
	readonly destinations?: readonly EventDestination[]
	readonly clock?: Clock
	readonly lifecycle?: LifecyclePort
	readonly strictDefinitions?: boolean
	readonly inline?: boolean
	readonly delivery?: {readonly pollIntervalMs?: number; readonly maintenanceIntervalMs?: number; readonly operationTimeoutMs?: number; readonly shutdownTimeoutMs?: number; readonly maxAttempts?: number; readonly maxConcurrent?: number}
}

export async function createCustomEvents(options: CustomEventsOptions): Promise<EventsRuntime> {
	isolateInputFields(options, ['backend', 'role', 'destinations', 'clock', 'lifecycle', 'strictDefinitions', 'inline', 'delivery'])
	const backend = inputField(options, 'backend', 'EVENTS_BACKEND_REQUIRED') as EventsBackend | undefined
	const delivery = inputField(options, 'delivery', 'EVENTS_OPTIONS_INVALID')
	const clock = inputField(options, 'clock', 'EVENTS_OPTIONS_INVALID') as Clock | undefined
	const lifecycle = inputField(options, 'lifecycle', 'EVENTS_OPTIONS_INVALID') as LifecyclePort | undefined
	const destinations = inputField(options, 'destinations', 'EVENTS_OPTIONS_INVALID') as readonly EventDestination[] | undefined
	isolateEventsBackendInput(backend)
	isolateInputFields(delivery, ['pollIntervalMs', 'maintenanceIntervalMs', 'operationTimeoutMs', 'shutdownTimeoutMs', 'maxAttempts', 'maxConcurrent'])
	isolateCapabilityFields(clock, ['now'])
	isolateCapabilityFields(lifecycle, ['registerFlushHook', 'registerShutdownHook'])
	isolateArrayItemFields(destinations, ['name', 'kind', 'deliver', 'startConsumer', 'flush', 'shutdown'])
	if (!backend) throw new Error('EVENTS_BACKEND_REQUIRED')
	const deliveryOptions = delivery === undefined ? {} : {
		pollIntervalMs: inputField(delivery, 'pollIntervalMs', 'EVENTS_OPTIONS_INVALID') as number | undefined,
		maintenanceIntervalMs: inputField(delivery, 'maintenanceIntervalMs', 'EVENTS_OPTIONS_INVALID') as number | undefined,
		operationTimeoutMs: inputField(delivery, 'operationTimeoutMs', 'EVENTS_OPTIONS_INVALID') as number | undefined,
		shutdownTimeoutMs: inputField(delivery, 'shutdownTimeoutMs', 'EVENTS_OPTIONS_INVALID') as number | undefined,
		maxAttempts: inputField(delivery, 'maxAttempts', 'EVENTS_OPTIONS_INVALID') as number | undefined,
		maxConcurrent: inputField(delivery, 'maxConcurrent', 'EVENTS_OPTIONS_INVALID') as number | undefined
	}
	return createEventsManager({
		clock: clock ?? createSystemClock(), backend,
		role: inputField(options, 'role', 'EVENTS_OPTIONS_INVALID') as EventsRole,
		destinations, lifecycle,
		strictDefinitions: (inputField(options, 'strictDefinitions', 'EVENTS_OPTIONS_INVALID') as boolean | undefined) ?? true,
		inline: inputField(options, 'inline', 'EVENTS_OPTIONS_INVALID') as boolean | undefined, ...deliveryOptions
	})
}
