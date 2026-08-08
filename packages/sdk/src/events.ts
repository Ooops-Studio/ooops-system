import type {
	EventDefinition,
	EventPayloadSchema
} from '@ooopsstudio/core/contracts/events'
import type {JsonValue} from '@ooopsstudio/core/contracts/json'

import {captureSingleFlightCallback} from './callback-flight'
import {
	boundedString,
	failDefinition,
	optionalBoundedString,
	readDenseArray,
	readPlainRecord,
	snapshotJsonValue
} from './definition-input'
import {runBoundedRuntimeReflection} from './reflection-flight'
import {isRuntimeProxy} from './runtime-object'

const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const CONSUMER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const EVENT_KEYS = new Set([
	'type', 'source', 'schema', 'summary', 'description', 'aggregateType', 'binding', 'defaultHeaders', 'version', 'tags'
])
const CONSUMER_KEYS = new Set(['name', 'eventTypes', 'concurrency'])
const BINDING_KEYS = new Set(['destination', 'target', 'options'])

export interface EventContractSchema<TPayload> extends EventPayloadSchema<TPayload> {
	readonly toJSONSchema?: () => Readonly<Record<string, unknown>>
}

export interface EventDestinationBinding {
	readonly destination: string
	readonly target: string
	readonly options?: Readonly<Record<string, JsonValue>>
}

export interface EventConsumerDefinition {
	readonly name: string
	readonly eventTypes: ReadonlyArray<string>
	readonly concurrency?: number
}

export interface DefineEventOptions<TPayload> {
	readonly type: string
	readonly source: string
	readonly schema: EventContractSchema<TPayload>
	readonly summary?: string
	readonly description?: string
	readonly aggregateType?: string
	readonly binding?: EventDestinationBinding
	readonly defaultHeaders?: EventDefinition<TPayload>['defaultHeaders']
	readonly version?: string
	readonly tags?: ReadonlyArray<string>
}

export interface DefinedEvent<TPayload> extends EventDefinition<TPayload> {
	readonly schema: EventContractSchema<TPayload>
	readonly binding?: EventDestinationBinding
}

function snapshotSchema<TPayload>(value: unknown): EventContractSchema<TPayload> {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) failDefinition('SDK_EVENT_SCHEMA_INVALID')
	if (isRuntimeProxy(value)) failDefinition('SDK_EVENT_SCHEMA_INVALID')
	let parse: PropertyDescriptor | undefined
	let toJsonSchema: PropertyDescriptor | undefined
	try { ({parse, toJsonSchema} = runBoundedRuntimeReflection(() => ({
		parse: Object.getOwnPropertyDescriptor(value, 'parse'),
		toJsonSchema: Object.getOwnPropertyDescriptor(value, 'toJSONSchema')
	}))) } catch { return failDefinition('SDK_EVENT_SCHEMA_INVALID') }
	if (!parse || !('value' in parse) || typeof parse.value !== 'function') failDefinition('SDK_EVENT_SCHEMA_INVALID')
	if (toJsonSchema && (!('value' in toJsonSchema) || typeof toJsonSchema.value !== 'function')) {
		failDefinition('SDK_EVENT_SCHEMA_INVALID')
	}
	const parseMethod = (parse as PropertyDescriptor & {value: (input: unknown) => TPayload}).value
	const safeParse = captureSingleFlightCallback(((input: unknown) =>
		runBoundedRuntimeReflection(() => Reflect.apply(parseMethod, value, [input]))) as (
		...args: never[]
	) => unknown) as (input: unknown) => TPayload
	const safeJsonSchema = toJsonSchema && captureSingleFlightCallback((() =>
		runBoundedRuntimeReflection(() => Reflect.apply(
			toJsonSchema.value as () => Readonly<Record<string, unknown>>, value, []
		))) as (...args: never[]) => unknown)
	return Object.freeze({
		parse(input: unknown): TPayload {
			return safeParse(input)
		},
		...(toJsonSchema ? {
			toJSONSchema(): Readonly<Record<string, unknown>> {
				return safeJsonSchema?.() as Readonly<Record<string, unknown>>
			}
		} : {})
	})
}

function snapshotTags(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined
	const tags = readDenseArray(value, 32, 'SDK_EVENT_TAGS_INVALID').map((tag) =>
		boundedString(tag, 'SDK_EVENT_TAG_INVALID', 64)
	)
	if (new Set(tags).size !== tags.length) failDefinition('SDK_EVENT_TAGS_DUPLICATE')
	return Object.freeze(tags)
}

function snapshotBinding(value: unknown): EventDestinationBinding | undefined {
	if (value === undefined) return undefined
	const input = readPlainRecord(value, 'SDK_EVENT_BINDING_INVALID', BINDING_KEYS)
	const options = input.options === undefined ? undefined : snapshotJsonValue(input.options, {
		code: 'SDK_EVENT_BINDING_OPTIONS_INVALID', maxArrayLength: 64, maxBytes: 16_384, maxDepth: 8,
		maxEntries: 64, maxKeyLength: 128, maxNodes: 512, maxStringLength: 4_096
	}) as Readonly<Record<string, never>>
	return Object.freeze({
		destination: boundedString(input.destination, 'SDK_EVENT_BINDING_DESTINATION_INVALID', 128, EVENT_TYPE_PATTERN),
		target: boundedString(input.target, 'SDK_EVENT_BINDING_TARGET_INVALID', 512),
		...(options === undefined ? {} : {options})
	})
}

export function defineEvent<TPayload>(rawOptions: DefineEventOptions<TPayload>): DefinedEvent<TPayload> {
	const options = readPlainRecord(rawOptions, 'SDK_EVENT_DEFINITION_INVALID', EVENT_KEYS)
	const tags = snapshotTags(options.tags)
	const binding = snapshotBinding(options.binding)
	const defaultHeaders = options.defaultHeaders === undefined ? undefined : snapshotJsonValue(options.defaultHeaders, {
		code: 'SDK_EVENT_HEADERS_INVALID', maxArrayLength: 64, maxBytes: 16_384, maxDepth: 8,
		maxEntries: 64, maxKeyLength: 128, maxNodes: 512, maxStringLength: 4_096
	}) as EventDefinition<TPayload>['defaultHeaders']
	return Object.freeze({
		type: boundedString(options.type, 'SDK_EVENT_TYPE_INVALID', 128, EVENT_TYPE_PATTERN),
		source: boundedString(options.source, 'SDK_EVENT_SOURCE_INVALID', 512),
		schema: snapshotSchema<TPayload>(options.schema),
		...(optionalBoundedString(options.summary, 'SDK_EVENT_SUMMARY_INVALID', 256) === undefined
			? {} : {summary: options.summary as string}),
		...(optionalBoundedString(options.description, 'SDK_EVENT_DESCRIPTION_INVALID', 4_096) === undefined
			? {} : {description: options.description as string}),
		...(optionalBoundedString(options.aggregateType, 'SDK_EVENT_AGGREGATE_TYPE_INVALID', 128) === undefined
			? {} : {aggregateType: options.aggregateType as string}),
		...(binding === undefined ? {} : {binding}),
		...(defaultHeaders === undefined ? {} : {defaultHeaders}),
		...(optionalBoundedString(options.version, 'SDK_EVENT_VERSION_INVALID', 64) === undefined
			? {} : {version: options.version as string}),
		...(tags === undefined ? {} : {tags})
	})
}

export function defineConsumer(rawDefinition: EventConsumerDefinition): EventConsumerDefinition {
	const definition = readPlainRecord(rawDefinition, 'SDK_EVENT_CONSUMER_INVALID', CONSUMER_KEYS)
	const eventTypes = readDenseArray(definition.eventTypes, 128, 'SDK_EVENT_CONSUMER_TYPES_INVALID').map((type) =>
		boundedString(type, 'SDK_EVENT_TYPE_INVALID', 128, EVENT_TYPE_PATTERN)
	)
	if (eventTypes.length === 0) failDefinition('SDK_EVENT_CONSUMER_TYPES_EMPTY')
	if (new Set(eventTypes).size !== eventTypes.length) failDefinition('SDK_EVENT_CONSUMER_TYPES_DUPLICATE')
	if (definition.concurrency !== undefined && (
		!Number.isSafeInteger(definition.concurrency) || (definition.concurrency as number) < 1 || (definition.concurrency as number) > 1_024
	)) failDefinition('SDK_EVENT_CONSUMER_CONCURRENCY_INVALID')
	return Object.freeze({
		name: boundedString(definition.name, 'SDK_EVENT_CONSUMER_NAME_INVALID', 128, CONSUMER_NAME_PATTERN),
		eventTypes: Object.freeze(eventTypes),
		...(definition.concurrency === undefined ? {} : {concurrency: definition.concurrency as number})
	})
}
