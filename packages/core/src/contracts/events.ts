/** Application-facing contracts for durable event publication and consumption. */

import type {JsonValue} from './json'

export type EventTransportKind = 'local' | 'http' | 'kafka' | 'nats' | 'custom'
export type EventDeliveryStatus = 'queued' | 'dispatching' | 'dispatched' | 'failed' | 'dead' | 'cancelled'
export type EventsRuntimeState = 'idle' | 'running' | 'draining' | 'closed'
export type EventsBackendState = 'healthy' | 'degraded' | 'unhealthy' | 'closed'

export interface EventPayloadSchema<TPayload = JsonValue> {
	parse(input: unknown): TPayload
}

/** A single immutable outbound destination selected at bootstrap. */
export interface EventDestinationBinding {
	readonly destination: string
	readonly target: string
	readonly options?: Readonly<Record<string, JsonValue>>
}

export interface EventDefinition<TPayload = JsonValue> {
	readonly type: string
	readonly source: string
	readonly summary?: string
	readonly description?: string
	readonly aggregateType?: string
	readonly schema: EventPayloadSchema<TPayload>
	readonly binding?: EventDestinationBinding
	readonly defaultHeaders?: Readonly<Record<string, JsonValue>>
	readonly version?: string
	readonly tags?: ReadonlyArray<string>
}

export interface EventEnvelope<TPayload = JsonValue> {
	readonly id: string
	readonly type: string
	readonly specVersion: '1.0'
	readonly source: string
	readonly subject?: string
	readonly aggregateType?: string
	readonly aggregateId?: string
	readonly partitionKey?: string
	readonly correlationId?: string
	readonly causationId?: string
	readonly tenantId?: string
	readonly occurredAt: string
	readonly availableAt?: string
	readonly expiresAt?: string
	readonly headers: Readonly<Record<string, JsonValue>>
	readonly payload: TPayload
}

export interface EventPublishOptions {
	readonly headers?: Readonly<Record<string, JsonValue>>
	readonly availableAt?: string | Date
	readonly expiresAt?: string | Date
	readonly correlationId?: string
	readonly causationId?: string
	readonly tenantId?: string
	readonly partitionKey?: string
	readonly subject?: string
	readonly aggregateId?: string
}

export interface EventPublishRequest<TPayload = unknown> {
	readonly type: string
	readonly payload: TPayload
	readonly options?: EventPublishOptions
}

export interface EventConsumerDefinition {
	readonly name: string
	readonly eventTypes: ReadonlyArray<string>
	readonly concurrency?: number
}

export interface EventConsumerContext {
	readonly consumer: string
	readonly attempt: number
	readonly transport: EventTransportKind
	readonly receivedAt: string
	readonly signal: AbortSignal
}

export type EventConsumerResult =
	| {readonly outcome: 'processed' | 'duplicate'}
	| {readonly outcome: 'failed'; readonly failureCode?: string}

export type EventConsumerHandler<TPayload = unknown> = (
	event: EventEnvelope<TPayload>,
	context: EventConsumerContext
) => Promise<EventConsumerResult | void> | EventConsumerResult | void

export interface EventsStatus {
	readonly state: EventsRuntimeState
	readonly backendState: EventsBackendState
	readonly activeOperations: number
	readonly queuedEvents: number
	readonly retriedTotal: number
	readonly deadLetteredTotal: number
	readonly lastFailureCode?: string
}

export interface EventOutboxSummary {
	readonly eventId: string
	readonly type: string
	readonly status: EventDeliveryStatus
	readonly attempts: number
	readonly createdAt: string
	readonly updatedAt: string
	readonly availableAt?: string
	readonly failureCode?: string
}

export interface EventDeadLetterSummary {
	readonly eventId: string
	readonly type: string
	readonly attempts: number
	readonly failedAt: string
	readonly failureCode: string
}

export interface EventReplayRequest {
	readonly eventId?: string
	readonly type?: string
	readonly from?: string
	readonly to?: string
	readonly limit?: number
}
