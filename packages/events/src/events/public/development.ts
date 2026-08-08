import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {EventsRuntime} from '@ooopsstudio/core/ports/events'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {createEventsManager} from '../manager'
import {createMemoryEventsBackend} from '../memory-backend'
import {inputField, isolateCapabilityFields, isolateInputFields} from '../safe-input'

export interface DevelopmentEventsOptions {
	readonly clock?: Clock
	readonly lifecycle?: LifecyclePort
	readonly maxRecords?: number
}

export async function createDevelopmentEvents(options: DevelopmentEventsOptions = {}): Promise<EventsRuntime> {
	isolateInputFields(options, ['clock', 'lifecycle', 'maxRecords'])
	const clock = inputField(options, 'clock', 'EVENTS_OPTIONS_INVALID') as Clock | undefined
	const lifecycle = inputField(options, 'lifecycle', 'EVENTS_OPTIONS_INVALID') as LifecyclePort | undefined
	isolateCapabilityFields(clock, ['now'])
	isolateCapabilityFields(lifecycle, ['registerFlushHook', 'registerShutdownHook'])
	return createEventsManager({
		clock: clock ?? createSystemClock(), lifecycle,
		backend: createMemoryEventsBackend({maxRecords: inputField(options, 'maxRecords', 'EVENTS_OPTIONS_INVALID') as number | undefined}),
		role: 'combined', inline: true,
		strictDefinitions: false, pollIntervalMs: 50, maintenanceIntervalMs: 5_000, maxAttempts: 3})
}
