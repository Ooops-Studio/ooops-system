import type {
	EventConsumerDefinition,
	EventConsumerHandler,
	EventDeadLetterSummary,
	EventDefinition,
	EventEnvelope,
	EventOutboxSummary,
	EventPublishOptions,
	EventPublishRequest,
	EventReplayRequest,
	EventsStatus
} from '../contracts/events'
import type {LifecycleHookDisposer} from '../contracts/lifecycle'

export interface EventsPort {
	publish<TPayload = unknown>(
		type: string,
		payload: TPayload,
		options?: EventPublishOptions
	): Promise<EventEnvelope<TPayload>>
	publishMany(requests: ReadonlyArray<EventPublishRequest>): Promise<ReadonlyArray<EventEnvelope>>
}

export interface ManagedEvents extends EventsPort {
	registerDefinition<TPayload = unknown>(definition: EventDefinition<TPayload>): void
	registerConsumer<TPayload = unknown>(
		definition: EventConsumerDefinition,
		handler: EventConsumerHandler<TPayload>
	): LifecycleHookDisposer
	start(): Promise<void>
	getStatus(): EventsStatus
	flush(): Promise<void>
	shutdown(): Promise<void>
}

export interface TransactionalEventsPort {
	publishTransactional<TPayload = unknown>(
		transaction: unknown,
		type: string,
		payload: TPayload,
		options?: EventPublishOptions
	): Promise<EventEnvelope<TPayload>>
}

export interface EventsAdminPort {
	replay(request: EventReplayRequest): Promise<number>
	retryDeadLetter(eventId: string): Promise<boolean>
	cancelScheduled(eventId: string): Promise<boolean>
	listOutbox(options?: {status?: EventOutboxSummary['status']; type?: string; limit?: number}): Promise<ReadonlyArray<EventOutboxSummary>>
	listDeadLetters(limit?: number): Promise<ReadonlyArray<EventDeadLetterSummary>>
	purgeExpired(): Promise<number>
}

export interface EventsRuntime {
	events: ManagedEvents
	transactional?: TransactionalEventsPort
	admin?: EventsAdminPort
}
