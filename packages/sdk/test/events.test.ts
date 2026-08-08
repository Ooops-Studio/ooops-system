import {describe, expect, it} from 'vitest'
import {z} from 'zod'

import {defineConsumer, defineEvent} from '../src/events'
import {generateAsyncApiDocument, generateJsonSchemas} from '../src/events-asyncapi'
import {createZodEventSchema} from '../src/events-zod'

const objectSchema = Object.freeze({
	parse(input: unknown): {id: string} {
		if (!input || typeof input !== 'object' || typeof (input as {id?: unknown}).id !== 'string') throw new TypeError('INVALID_PAYLOAD')
		return {id: (input as {id: string}).id}
	},
	toJSONSchema(): Readonly<Record<string, unknown>> {
		return {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}
	}
})

describe('events build-time SDK', () => {
	it('defines schema-agnostic deeply immutable event snapshots', () => {
		const tags = ['documents']
		const headers = {tenant: 'public', nested: {enabled: true}}
		const bindingOptions = {region: 'eu'}
		const event = defineEvent({
			type: 'document.created', source: 'suite', schema: objectSchema, tags, defaultHeaders: headers,
			binding: {destination: 'webhooks', target: 'documents', options: bindingOptions}
		})
		tags[0] = 'changed'
		headers.nested.enabled = false
		bindingOptions.region = 'us'

		expect(event.schema.parse({id: 'one'})).toEqual({id: 'one'})
		expect(event.tags).toEqual(['documents'])
		expect(event.defaultHeaders).toEqual({tenant: 'public', nested: {enabled: true}})
		expect(event.binding?.options).toEqual({region: 'eu'})
		expect(Object.isFrozen(event)).toBe(true)
		expect(Object.isFrozen(event.defaultHeaders?.nested)).toBe(true)
	})

	it('isolates Zod behind the explicit adapter', () => {
		const schema = createZodEventSchema(z.object({id: z.string()}))
		const event = defineEvent({type: 'document.created', source: 'suite', schema})
		expect(event.schema.parse({id: 'one'})).toEqual({id: 'one'})
		expect(schema.safeParse({id: 1}).success).toBe(false)
		expect(schema.toJSONSchema?.()).toMatchObject({type: 'object'})
	})

	it('copies and freezes consumer definitions', () => {
		const eventTypes = ['document.created']
		const consumer = defineConsumer({name: 'documents', eventTypes, concurrency: 4})
		eventTypes[0] = 'changed'
		expect(consumer).toEqual({name: 'documents', eventTypes: ['document.created'], concurrency: 4})
		expect(Object.isFrozen(consumer)).toBe(true)
		expect(Object.isFrozen(consumer.eventTypes)).toBe(true)
	})

	it('rejects malformed, duplicate and accessor-backed definitions deterministically', () => {
		expect(() => defineConsumer({name: 'documents', eventTypes: ['one', 'one']}))
			.toThrow('SDK_EVENT_CONSUMER_TYPES_DUPLICATE')
		expect(() => defineEvent({type: '../unsafe', source: 'suite', schema: objectSchema}))
			.toThrow('SDK_EVENT_TYPE_INVALID')
		const hostile = Object.defineProperty({}, 'type', {get: () => 'document.created'})
		expect(() => defineEvent(hostile as never)).toThrow('SDK_EVENT_DEFINITION_INVALID')
		expect(() => defineEvent({
			type: 'document.created', source: 'suite', schema: new Proxy(objectSchema, {})
		})).toThrow('SDK_EVENT_SCHEMA_INVALID')
		expect(() => createZodEventSchema(new Proxy(z.string(), {}))).toThrow('SDK_EVENT_ZOD_SCHEMA_INVALID')
	})

	it('generates frozen JSON Schema and AsyncAPI artifacts', () => {
		const event = defineEvent({type: 'document.created', source: 'suite', schema: objectSchema})
		const consumers = [defineConsumer({name: 'documents', eventTypes: [event.type]})]
		const schemas = generateJsonSchemas([event])
		const artifact = generateAsyncApiDocument({events: [event], consumers})
		expect(schemas).toHaveLength(1)
		expect(Object.isFrozen(schemas)).toBe(true)
		expect(Object.isFrozen(schemas[0]?.jsonSchema)).toBe(true)
		expect(JSON.parse(artifact.asyncapi).operations).toHaveProperty('documents.document.created.receive')
		expect(Object.isFrozen(artifact)).toBe(true)
	})

	it('rejects duplicate identities and unknown consumer event references', () => {
		const event = defineEvent({type: 'document.created', source: 'suite', schema: objectSchema})
		expect(() => generateAsyncApiDocument({events: [event, event]})).toThrow('SDK_ASYNCAPI_EVENT_TYPE_DUPLICATE')
		expect(() => generateAsyncApiDocument({
			events: [event], consumers: [defineConsumer({name: 'documents', eventTypes: ['document.deleted']})]
		})).toThrow('SDK_ASYNCAPI_CONSUMER_EVENT_UNKNOWN')
		expect(() => generateAsyncApiDocument({
			events: [event], consumers: [
				defineConsumer({name: 'documents', eventTypes: [event.type]}),
				defineConsumer({name: 'documents', eventTypes: [event.type]})
			]
		})).toThrow('SDK_ASYNCAPI_CONSUMER_DUPLICATE')
	})

	it('rejects oversized or cyclic generated schemas', () => {
		const oversized = defineEvent({
			type: 'large.event', source: 'suite',
			schema: Object.freeze({parse: (input: unknown) => input, toJSONSchema: () => ({description: 'x'.repeat(262_145)})})
		})
		expect(() => generateJsonSchemas([oversized])).toThrow('SDK_ASYNCAPI_SCHEMA_INVALID')

		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const cyclicEvent = defineEvent({
			type: 'cyclic.event', source: 'suite',
			schema: Object.freeze({parse: (input: unknown) => input, toJSONSchema: () => cyclic})
		})
		expect(() => generateJsonSchemas([cyclicEvent])).toThrow('SDK_ASYNCAPI_SCHEMA_INVALID')
	})
})
