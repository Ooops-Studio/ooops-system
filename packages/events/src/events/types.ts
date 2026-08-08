import type {
	EventDeadLetterSummary,
	EventDeliveryStatus,
	EventDestinationBinding,
	EventEnvelope,
	EventOutboxSummary,
	EventReplayRequest,
	EventTransportKind
} from '@ooopsstudio/core/contracts/events'

export interface StoredTraceContext {
	readonly traceparent: string
	readonly tracestate?: string
	readonly baggage?: string
}

export interface StoredEventRecord {
	readonly envelope: EventEnvelope<unknown>
	/** Internal provenance: the envelope payload was normalized by its registered schema before persistence. */
	readonly payloadValidated?: true
	readonly binding?: EventDestinationBinding
	readonly traceContext?: StoredTraceContext
	readonly status: EventDeliveryStatus
	readonly attempts: number
	readonly availableAt: number
	readonly expiresAt?: number
	readonly createdAt: number
	readonly updatedAt: number
	readonly lease?: {readonly owner: string; readonly expiresAt: number; readonly generation: number}
	readonly failureCode?: string
}

export interface EventOutboxStore {
	append(records: readonly StoredEventRecord[]): Promise<void>
	claimDue(input: {now: number; limit: number; owner: string; leaseMs: number}): Promise<readonly StoredEventRecord[]>
	renew(eventId: string, owner: string, generation: number, expiresAt: number): Promise<boolean>
	complete(eventId: string, owner: string, generation: number): Promise<boolean>
	retry(eventId: string, owner: string, generation: number, availableAt: number, failureCode: string): Promise<boolean>
	deadLetter(eventId: string, owner: string, generation: number, failureCode: string): Promise<boolean>
	purgeExpired(now: number, limit: number): Promise<number>
	queuedCount(): Promise<number>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

export type EventInboxClaim = 'claimed' | 'duplicate' | 'busy'
export interface EventInboxStore {
	claim(input: {consumer: string; eventId: string; owner: string; expiresAt: number; now?: number}): Promise<EventInboxClaim>
	renew(input: {consumer: string; eventId: string; owner: string; expiresAt: number}): Promise<boolean>
	complete(input: {consumer: string; eventId: string; owner: string}): Promise<boolean>
	release(input: {consumer: string; eventId: string; owner: string}): Promise<boolean>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}

export interface TransactionalEventStore {
	appendTransactional(transaction: unknown, records: readonly StoredEventRecord[]): Promise<void>
}

export interface EventAdminStore {
	replay(request: EventReplayRequest, now: number): Promise<number>
	retryDeadLetter(eventId: string, now: number): Promise<boolean>
	cancelScheduled(eventId: string, now: number): Promise<boolean>
	listOutbox(options?: {status?: EventDeliveryStatus; type?: string; limit?: number}): Promise<readonly EventOutboxSummary[]>
	listDeadLetters(limit?: number): Promise<readonly EventDeadLetterSummary[]>
	purgeExpired(now: number, limit: number): Promise<number>
}

export interface EventBackendCompatibility {
	check(): Promise<{compatible: true} | {compatible: false; code?: string}>
}

export interface EventsBackend {
	readonly durability: 'ephemeral' | 'durable'
	readonly outbox: EventOutboxStore
	readonly inbox?: EventInboxStore
	readonly transactional?: TransactionalEventStore
	readonly admin?: EventAdminStore
	readonly compatibility?: EventBackendCompatibility
}

export interface EventDeliveryResult {
	readonly status: 'success' | 'retryable' | 'permanent-failure'
	readonly retryAfterMs?: number
}

export interface EventDestination {
	readonly name: string
	readonly kind: Exclude<EventTransportKind, 'local'>
	deliver(event: EventEnvelope<unknown>, binding: EventDestinationBinding, signal: AbortSignal): Promise<void | EventDeliveryResult>
	startConsumer?(onEvent: (event: EventEnvelope<unknown>) => Promise<void>): Promise<() => void | Promise<void>>
	flush?(): Promise<void>
	shutdown?(): Promise<void>
}
