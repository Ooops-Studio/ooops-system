import type {EventDefinition} from '@ooopsstudio/core/contracts/events'

import {
	boundedString,
	failDefinition,
	readDenseArray,
	readPlainRecord,
	snapshotJsonValue
} from './definition-input'
import {defineConsumer, defineEvent, type DefinedEvent, type EventConsumerDefinition} from './events'

const DOCUMENT_KEYS = new Set(['title', 'version', 'events', 'consumers'])
const MAX_EVENTS = 512
const MAX_CONSUMERS = 512
const MAX_SCHEMA_BYTES = 262_144
const MAX_TOTAL_SCHEMA_BYTES = 2_097_152
const textEncoder = new TextEncoder()

export interface EventSchemaArtifact {
	readonly eventType: string
	readonly schemaRef: string
	readonly jsonSchema: Readonly<Record<string, unknown>>
}

export interface EventContractArtifact {
	readonly asyncapi: string
	readonly schemas: ReadonlyArray<EventSchemaArtifact>
}

function jsonSchemaFor(definition: DefinedEvent<unknown>): Readonly<Record<string, unknown>> {
	let rawSchema: unknown = {type: 'object', additionalProperties: true}
	try {
		if (definition.schema.toJSONSchema) rawSchema = definition.schema.toJSONSchema()
	} catch {
		return failDefinition('SDK_ASYNCAPI_SCHEMA_INVALID')
	}
	const schema = snapshotJsonValue(rawSchema, {
		code: 'SDK_ASYNCAPI_SCHEMA_INVALID', maxArrayLength: 4_096, maxBytes: MAX_SCHEMA_BYTES, maxDepth: 32,
		maxEntries: 4_096, maxKeyLength: 256, maxNodes: 32_768, maxStringLength: MAX_SCHEMA_BYTES
	})
	if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) failDefinition('SDK_ASYNCAPI_SCHEMA_INVALID')
	return schema as Readonly<Record<string, unknown>>
}

function normalizeEvents(value: unknown): readonly DefinedEvent<unknown>[] {
	const rawEvents = readDenseArray(value, MAX_EVENTS, 'SDK_ASYNCAPI_EVENTS_INVALID')
	if (rawEvents.length === 0) failDefinition('SDK_ASYNCAPI_EVENTS_EMPTY')
	const events = rawEvents.map((event) => defineEvent(event as EventDefinition<unknown>))
	const types = new Set<string>()
	for (const event of events) {
		if (types.has(event.type)) failDefinition('SDK_ASYNCAPI_EVENT_TYPE_DUPLICATE')
		types.add(event.type)
	}
	return Object.freeze(events)
}

function normalizeConsumers(value: unknown, eventTypes: ReadonlySet<string>): readonly EventConsumerDefinition[] {
	if (value === undefined) return Object.freeze([])
	const rawConsumers = readDenseArray(value, MAX_CONSUMERS, 'SDK_ASYNCAPI_CONSUMERS_INVALID')
	const consumers = rawConsumers.map((consumer) => defineConsumer(consumer as EventConsumerDefinition))
	const names = new Set<string>()
	for (const consumer of consumers) {
		if (names.has(consumer.name)) failDefinition('SDK_ASYNCAPI_CONSUMER_DUPLICATE')
		names.add(consumer.name)
		for (const eventType of consumer.eventTypes) {
			if (!eventTypes.has(eventType)) failDefinition('SDK_ASYNCAPI_CONSUMER_EVENT_UNKNOWN')
		}
	}
	return Object.freeze(consumers)
}

function createSchemas(events: readonly DefinedEvent<unknown>[]): readonly EventSchemaArtifact[] {
	let totalBytes = 0
	const schemas = events.map((definition) => {
		const jsonSchema = jsonSchemaFor(definition)
		const schemaBytes = textEncoder.encode(JSON.stringify(jsonSchema)).byteLength
		if (schemaBytes > MAX_SCHEMA_BYTES) failDefinition('SDK_ASYNCAPI_SCHEMA_INVALID')
		totalBytes += schemaBytes
		if (totalBytes > MAX_TOTAL_SCHEMA_BYTES) failDefinition('SDK_ASYNCAPI_SCHEMAS_TOO_LARGE')
		return Object.freeze({
			eventType: definition.type,
			schemaRef: `${definition.source}/${definition.type}`,
			jsonSchema
		})
	})
	return Object.freeze(schemas)
}

export function generateJsonSchemas(definitions: ReadonlyArray<EventDefinition>): ReadonlyArray<EventSchemaArtifact> {
	return createSchemas(normalizeEvents(definitions))
}

export function generateAsyncApiDocument(rawInput: {
	readonly title?: string
	readonly version?: string
	readonly events: ReadonlyArray<EventDefinition>
	readonly consumers?: ReadonlyArray<EventConsumerDefinition>
}): EventContractArtifact {
	const input = readPlainRecord(rawInput, 'SDK_ASYNCAPI_INPUT_INVALID', DOCUMENT_KEYS)
	const events = normalizeEvents(input.events)
	const eventTypes = new Set(events.map((event) => event.type))
	const consumers = normalizeConsumers(input.consumers, eventTypes)
	const schemas = createSchemas(events)
	const channels: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	const operations: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	const messages: Record<string, unknown> = Object.create(null) as Record<string, unknown>

	for (let index = 0; index < events.length; index += 1) {
		const event = events[index] as DefinedEvent<unknown>
		channels[event.type] = Object.freeze({
			address: event.type,
			messages: Object.freeze({[event.type]: Object.freeze({$ref: `#/components/messages/${event.type}`})})
		})
		const sendOperation = `${event.type}.send`
		if (operations[sendOperation] !== undefined) failDefinition('SDK_ASYNCAPI_OPERATION_DUPLICATE')
		operations[sendOperation] = Object.freeze({action: 'send', channel: Object.freeze({$ref: `#/channels/${event.type}`})})
		messages[event.type] = Object.freeze({
			name: event.type,
			title: event.summary ?? event.type,
			...(event.description === undefined ? {} : {description: event.description}),
			payload: (schemas[index] as EventSchemaArtifact).jsonSchema,
			...(event.binding ? {'x-ooops-destination': event.binding.destination} : {})
		})
	}

	for (const consumer of consumers) {
		for (const eventType of consumer.eventTypes) {
			const operationId = `${consumer.name}.${eventType}.receive`
			if (operations[operationId] !== undefined) failDefinition('SDK_ASYNCAPI_OPERATION_DUPLICATE')
			operations[operationId] = Object.freeze({
				action: 'receive', channel: Object.freeze({$ref: `#/channels/${eventType}`})
			})
		}
	}

	const document = Object.freeze({
		asyncapi: '3.1.0',
		info: Object.freeze({
			title: input.title === undefined ? 'Ooops Events' : boundedString(input.title, 'SDK_ASYNCAPI_TITLE_INVALID', 256),
			version: input.version === undefined ? '1.0.0' : boundedString(input.version, 'SDK_ASYNCAPI_VERSION_INVALID', 64)
		}),
		channels: Object.freeze(channels),
		operations: Object.freeze(operations),
		components: Object.freeze({messages: Object.freeze(messages)})
	})
	return Object.freeze({asyncapi: JSON.stringify(document, null, 2), schemas})
}
