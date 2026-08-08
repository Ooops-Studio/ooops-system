import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {EventsRuntime} from '@ooopsstudio/core/ports/events'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createEventsManager, type EventsRole} from '../manager'
import {
	inputField, isolateArrayItemFields, isolateCapabilityFields, isolateEventsBackendInput, isolateInputFields
} from '../safe-input'
import type {EventDestination, EventsBackend} from '../types'

export interface ProductionEventsOptions {
	readonly backend: EventsBackend
	readonly role: EventsRole
	readonly destinations?: readonly EventDestination[]
	readonly clock?: Clock
	readonly lifecycle?: LifecyclePort
}

export async function createProductionEvents(options: ProductionEventsOptions): Promise<EventsRuntime> {
	isolateInputFields(options, ['backend', 'role', 'destinations', 'clock', 'lifecycle'])
	const backend = inputField(options, 'backend', 'EVENTS_DURABLE_BACKEND_REQUIRED') as EventsBackend | undefined
	const clock = inputField(options, 'clock', 'EVENTS_OPTIONS_INVALID') as Clock | undefined
	const lifecycle = inputField(options, 'lifecycle', 'EVENTS_OPTIONS_INVALID') as LifecyclePort | undefined
	const destinations = inputField(options, 'destinations', 'EVENTS_OPTIONS_INVALID') as readonly EventDestination[] | undefined
	isolateEventsBackendInput(backend)
	isolateCapabilityFields(clock, ['now'])
	isolateCapabilityFields(lifecycle, ['registerFlushHook', 'registerShutdownHook'])
	isolateArrayItemFields(destinations, ['name', 'kind', 'deliver', 'startConsumer', 'flush', 'shutdown'])
	if (!backend || inputField(backend, 'durability', 'EVENTS_DURABLE_BACKEND_REQUIRED') !== 'durable') throw new Error('EVENTS_DURABLE_BACKEND_REQUIRED')
	return createEventsManager({
		clock: clock ?? createSystemClock(), backend,
		role: inputField(options, 'role', 'EVENTS_OPTIONS_INVALID') as EventsRole,
		destinations, lifecycle,
		strictDefinitions: true, pollIntervalMs: 250,
		maintenanceIntervalMs: 30_000, operationTimeoutMs: 10_000, shutdownTimeoutMs: 30_000, maxAttempts: 8, maxConcurrent: 16})
}
