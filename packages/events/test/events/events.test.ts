import {createContainer} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerEvents} from '../../src/events'
import {createEventsManager} from '../../src/events/manager'
import {createMemoryEventsBackend} from '../../src/events/memory-backend'
import {createPostgresEventMigrations} from '../../src/events/migrations/postgres'
import {createPostgresEventsBackend} from '../../src/events/postgres-backend'
import {createCustomEvents} from '../../src/events/public/custom'
import {createProductionEvents} from '../../src/events/public/production'
import {attachEventsTelemetry as attachEventsObservability} from '../../src/events/telemetry'
import {createHttpWebhookEventTransport} from '../../src/events/transports/http'
import {createKafkaEventTransport} from '../../src/events/transports/kafka'
import {createNatsEventTransport} from '../../src/events/transports/nats'

import {wireEventsObservabilityForTest as wireEventsObservability} from './observability-fixture'

const clock = {now: () => Date.now()}
const schema = {parse: (value: unknown) => value as {value: string}}

describe('simplified events runtime', () => {
	it('publishes and consumes through the durable attempt pipeline', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true})
		const handler = vi.fn()
		runtime.events.registerDefinition({type: 'test.created', source: 'test', schema})
		runtime.events.registerConsumer({name: 'test-consumer', eventTypes: ['test.created']}, handler)
		await runtime.events.start()
		const event = await runtime.events.publish('test.created', {value: 'ok'})
		expect(event.type).toBe('test.created')
		expect(handler).toHaveBeenCalledTimes(1)
		expect(runtime.events.getStatus().queuedEvents).toBe(0)
		await runtime.events.shutdown()
	})

	it('does not parse an already-normalized outbox payload a second time', async() => {
		const parse = vi.fn((value: unknown) => {
			if (typeof value !== 'string') throw new Error('schema accepts only source strings')
			return {normalized: value}
		})
		const handler = vi.fn()
		const runtime = await createEventsManager({
			clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true
		})
		runtime.events.registerDefinition({type: 'transform.created', source: 'test', schema: {parse}})
		runtime.events.registerConsumer({name: 'transform-consumer', eventTypes: ['transform.created']}, handler)
		await runtime.events.start()
		const published = await runtime.events.publish('transform.created', 'source')
		expect(published.payload).toEqual({normalized: 'source'})
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({payload: {normalized: 'source'}}),
			expect.any(Object)
		)
		expect(parse).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
	})

	it('validates events published before their definition was registered', async() => {
		const parse = vi.fn((value: unknown) => ({normalized: String(value)}))
		const handler = vi.fn()
		const runtime = await createEventsManager({
			clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true, strictDefinitions: false
		})
		await runtime.events.publish('late-definition.created', 42)
		runtime.events.registerDefinition({type: 'late-definition.created', source: 'test', schema: {parse}})
		runtime.events.registerConsumer({name: 'late-definition-consumer', eventTypes: ['late-definition.created']}, handler)
		await runtime.events.start()
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({payload: {normalized: '42'}}),
			expect.any(Object)
		)
		expect(parse).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
	})

	it('locks definitions and consumers at the first start', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		expect(() => runtime.events.registerDefinition({type: 'late', source: 'test', schema})).toThrow('EVENTS_REGISTRATION_CLOSED')
		expect(() => runtime.events.registerConsumer({name: 'late', eventTypes: ['late']}, vi.fn())).toThrow('EVENTS_REGISTRATION_CLOSED')
		await runtime.events.shutdown()
	})

	it('dead-letters unroutable events instead of silently marking them dispatched', async() => {
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true,
			strictDefinitions: true
		})
		runtime.events.registerDefinition({type: 'unrouted.event', source: 'test', schema})
		await runtime.events.start()
		const event = await runtime.events.publish('unrouted.event', {value: 'lost'})
		await expect(runtime.admin!.listDeadLetters()).resolves.toEqual([
			expect.objectContaining({eventId: event.id, failureCode: 'EVENTS_DELIVERY_UNROUTED'})
		])
		expect(runtime.events.getStatus()).toMatchObject({deadLetteredTotal: 1})
		await runtime.events.shutdown()
	})

	it('exposes no fake transactional capability from memory', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		expect(runtime.transactional).toBeUndefined()
		expect(runtime.admin).toBeDefined()
		await runtime.events.shutdown()
	})

	it('returns deeply frozen safe status and admin summaries', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		await runtime.events.publish('unknown', {secret: 'value'})
		const status = runtime.events.getStatus()
		expect(Object.isFrozen(status)).toBe(true)
		const rows = await runtime.admin!.listOutbox()
		expect(rows[0]).not.toHaveProperty('payload')
		expect(rows[0]).not.toHaveProperty('headers')
		await runtime.events.shutdown()
	})

	it('closes admission before draining and is idempotent', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		const first = runtime.events.shutdown()
		await expect(runtime.events.publish('late', {})).rejects.toThrow('EVENTS_ADMISSION_CLOSED')
		await Promise.all([first, runtime.events.shutdown()])
		expect(runtime.events.getStatus().state).toBe('closed')
		await expect(runtime.events.shutdown()).resolves.toBeUndefined()
	})

	it('flush does not close admission', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start(); await runtime.events.flush()
		await expect(runtime.events.publish('still-open', {})).resolves.toMatchObject({type: 'still-open'})
		await runtime.events.shutdown()
	})

	it('uses a stable flush cutoff instead of adopting later publications', async() => {
		const backend = createMemoryEventsBackend()
		const append = backend.outbox.append.bind(backend.outbox)
		let releaseFirst!: () => void
		let releaseSecond!: () => void
		let firstEntered!: () => void
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
		const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
		const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve })
		let calls = 0
		backend.outbox.append = async(records) => {
			const call = ++calls
			if (call === 1) { firstEntered(); await firstGate }
			if (call === 2) await secondGate
			await append(records)
		}
		const runtime = await createEventsManager({clock, backend, role: 'publisher'})
		await runtime.events.start()
		const first = runtime.events.publish('first', {})
		await firstStarted
		let flushSettled = false
		const flush = runtime.events.flush().finally(() => { flushSettled = true })
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		let secondSettled = false
		const second = runtime.events.publish('second', {}).finally(() => { secondSettled = true })
		releaseFirst()
		await first
		await vi.waitFor(() => expect(flushSettled).toBe(true))
		expect(secondSettled).toBe(false)
		releaseSecond()
		await Promise.all([second, flush])
		await runtime.events.shutdown()
	})

	it('orders shutdown after an already-running external flush', async() => {
		let entered!: () => void
		let release!: () => void
		const flushEntered = new Promise<void>((resolve) => { entered = resolve })
		const flushGate = new Promise<void>((resolve) => { release = resolve })
		let firstFlushRunning = false
		let flushCalls = 0
		const destinationShutdown = vi.fn(async() => {
			if (firstFlushRunning) throw new Error('shutdown overlapped flush')
		})
		const runtime = await createEventsManager({
			clock, backend: createMemoryEventsBackend(), role: 'publisher',
			destinations: [{
				name: 'ordered', kind: 'custom', deliver: async() => undefined,
				flush: async() => {
					flushCalls++
					if (flushCalls !== 1) return
					firstFlushRunning = true
					entered()
					await flushGate
					firstFlushRunning = false
				},
				shutdown: destinationShutdown
			}]
		})
		await runtime.events.start()
		const flushing = runtime.events.flush()
		await flushEntered
		const shuttingDown = runtime.events.shutdown()
		await Promise.resolve()
		expect(destinationShutdown).not.toHaveBeenCalled()
		release()
		await expect(Promise.all([flushing, shuttingDown])).resolves.toEqual([undefined, undefined])
		expect(destinationShutdown).toHaveBeenCalledTimes(1)
	})

	it('contains awaited flush re-entry and keeps external flush calls single-flight', async() => {
		let runtime!: Awaited<ReturnType<typeof createEventsManager>>
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const backend = createMemoryEventsBackend()
		backend.outbox.flush = vi.fn(async() => {
			await runtime.events.flush()
			await gate
		})
		runtime = await createEventsManager({clock, backend, role: 'publisher'})
		await runtime.events.start()
		const first = runtime.events.flush()
		let secondSettled = false
		const second = runtime.events.flush().finally(() => { secondSettled = true })
		await vi.waitFor(() => expect(backend.outbox.flush).toHaveBeenCalledTimes(1))
		expect(secondSettled).toBe(false)
		release()
		await Promise.all([first, second])
		await runtime.events.shutdown()
	})

	it('snapshots publication policy instead of rereading mutable manager options', async() => {
		const handler = vi.fn()
		const options = {
			clock, backend: createMemoryEventsBackend(), role: 'combined' as const,
			inline: false, strictDefinitions: false
		}
		const runtime = await createEventsManager(options)
		runtime.events.registerConsumer({name: 'policy-consumer', eventTypes: ['policy.event']}, handler)
		await runtime.events.start()
		options.inline = true
		options.strictDefinitions = true
		await expect(runtime.events.publish('policy.event', {})).resolves.toMatchObject({type: 'policy.event'})
		expect(handler).not.toHaveBeenCalled()
		await runtime.events.shutdown()
	})

	it('captures destination and lifecycle capabilities before the first construction await', async() => {
		let finishCompatibility!: () => void
		const compatible = new Promise<void>((resolve) => { finishCompatibility = resolve })
		const memory = createMemoryEventsBackend()
		const deliver = vi.fn(async() => ({status: 'success' as const}))
		const destination = {name: 'remote', kind: 'custom' as const, deliver}
		const registerFlushHook = vi.fn(() => () => undefined)
		const registerShutdownHook = vi.fn(() => () => undefined)
		const lifecycle = {registerFlushHook, registerShutdownHook}
		const options = {
			clock,
			backend: {
				...memory, durability: 'durable' as const,
				compatibility: {check: async() => { await compatible; return {compatible: true as const} }}
			},
			role: 'combined' as const,
			inline: true,
			destinations: [destination],
			lifecycle
		}
		const creating = createEventsManager(options)
		destination.deliver = async() => { throw new Error('mutated destination') }
		options.destinations = [{name: 'mutated', kind: 'custom', deliver: async() => undefined}]
		options.lifecycle = {
			registerFlushHook: () => { throw new Error('mutated lifecycle') },
			registerShutdownHook: () => { throw new Error('mutated lifecycle') }
		}
		finishCompatibility()
		const runtime = await creating
		runtime.events.registerDefinition({
			type: 'captured.event', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		await runtime.events.start()
		await runtime.events.publish('captured.event', {value: 'ok'})
		expect(deliver).toHaveBeenCalledTimes(1)
		expect(registerFlushHook).toHaveBeenCalledTimes(1)
		expect(registerShutdownHook).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
	})

	it('produces exactly the approved self-metric families', async() => {
		const names = new Set<string>(); const metrics = {increment: (name: string) => { names.add(name) }, record: (name: string) => { names.add(name) }}
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true})
		runtime.events.registerDefinition({type: 'metric.event', source: 'test', schema})
		runtime.events.registerConsumer({name: 'metric-consumer', eventTypes: ['metric.event']}, async() => {})
		const dispose = wireEventsObservability(runtime.events, {metrics})
		await runtime.events.start(); await runtime.events.publish('metric.event', {value: 'ok'}); await runtime.events.shutdown(); dispose()
		expect([...names].every((name) => ['_events_published_total', '_events_delivered_total', '_events_consumed_total', '_events_retries_total', '_events_active_operations', '_events_queue_size', '_events_finalization_failures_total'].includes(name))).toBe(true)
		expect(names).toContain('_events_published_total'); expect(names).toContain('_events_consumed_total')
	})

	it('permits only one observability attachment', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		wireEventsObservability(runtime.events, {})
		expect(() => wireEventsObservability(runtime.events, {})).toThrow('EVENTS_OBSERVABILITY_ALREADY_ATTACHED')
		await runtime.events.shutdown()
	})

	it('captures telemetry hooks once and rejects accessor-backed hooks without consuming the attachment slot', async() => {
		const backend = createMemoryEventsBackend()
		const append = vi.spyOn(backend.outbox, 'append')
		const runtime = await createEventsManager({clock, backend, role: 'publisher'})
		const getter = vi.fn(() => async(work: () => Promise<unknown>) => work())
		const hostile = Object.defineProperty({emit: () => undefined}, 'withPublish', {get: getter})

		expect(() => attachEventsObservability(runtime.events, hostile as never)).toThrow('EVENTS_EXTENSION_INVALID')
		expect(getter).not.toHaveBeenCalled()

		const attachment = {
			emit: () => undefined,
			withPublish: async(work: () => unknown | Promise<unknown>) => work()
		}
		attachEventsObservability(runtime.events, attachment)
		attachment.withPublish = async() => { throw new Error('mutated telemetry hook') }
		await runtime.events.start()
		await expect(runtime.events.publish('observed.event', {})).resolves.toMatchObject({type: 'observed.event'})
		expect(append).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
	})

	it('keeps raw observability fail-open and business operations exactly once', async() => {
		const backend = createMemoryEventsBackend()
		const append = vi.spyOn(backend.outbox, 'append')
		const handler = vi.fn()
		const runtime = await createEventsManager({clock, backend, role: 'combined', inline: true})
		runtime.events.registerConsumer({name: 'observed-consumer', eventTypes: ['observed.event']}, handler)
		attachEventsObservability(runtime.events, {
			emit: () => undefined,
			traceContext: () => { throw new Error('telemetry failed') },
			withPublish: async(work) => { await Promise.all([work(), work()]); return undefined as never },
			withConsume: () => new Promise<never>(() => undefined)
		})
		await runtime.events.start()
		await expect(runtime.events.publish('observed.event', {})).resolves.toMatchObject({type: 'observed.event'})
		expect(append).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
	})

	it('contains rejected promises from synchronous raw telemetry hooks', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		attachEventsObservability(runtime.events, {
			emit: () => Promise.reject(new Error('emit rejection')),
			traceContext: () => Promise.reject(new Error('trace rejection'))
		} as never)
		await runtime.events.start()
		await expect(runtime.events.publish('telemetry.rejection', {})).resolves.toMatchObject({type: 'telemetry.rejection'})
		await runtime.events.shutdown()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('keeps shutdown retryable and fences a late physical close', async() => {
		const base = createMemoryEventsBackend()
		let resolveClose!: () => void
		const close = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve }))
		const runtime = await createEventsManager({
			clock,
			backend: {...base, outbox: {...base.outbox, shutdown: close}},
			role: 'publisher',
			operationTimeoutMs: 100
		})
		await runtime.events.start()
		await expect(runtime.events.shutdown()).rejects.toThrow('EVENTS_BACKEND_SHUTDOWN_TIMEOUT')
		expect(runtime.events.getStatus()).toMatchObject({state: 'draining', backendState: 'unhealthy'})

		const retry = runtime.events.shutdown()
		expect(close).toHaveBeenCalledTimes(1)
		resolveClose()
		await retry
		expect(close).toHaveBeenCalledTimes(1)
		expect(runtime.events.getStatus().state).toBe('closed')
	})

	it('rejects accessors and oversized public payloads without executing them', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		const getter = vi.fn(() => 'secret')
		const hostile = Object.defineProperty({}, 'secret', {enumerable: true, get: getter})

		await expect(runtime.events.publish('hostile', hostile)).rejects.toThrow('EVENTS_PAYLOAD_INVALID')
		expect(getter).not.toHaveBeenCalled()
		await expect(runtime.events.publish('large', {value: 'x'.repeat(1_000_001)})).rejects.toThrow('EVENTS_PAYLOAD_LIMIT')
		await expect(runtime.events.publish('escaped-large', {value: '\0'.repeat(200_000)}))
			.rejects.toThrow('EVENTS_PAYLOAD_LIMIT')
		await runtime.events.shutdown()
	})

	it('contains rejected promises returned by synchronous schema and clock extensions', async() => {
		const schemaRuntime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		schemaRuntime.events.registerDefinition({
			type: 'async.schema', source: 'test', schema: {parse: () => Promise.reject(new Error('schema rejection'))} as never
		})
		await schemaRuntime.events.start()
		await expect(schemaRuntime.events.publish('async.schema', {})).rejects.toThrow('EVENTS_PAYLOAD_INVALID')
		await schemaRuntime.events.shutdown()

		const clockRuntime = await createEventsManager({
			clock: {now: () => Promise.reject(new Error('clock rejection'))} as never,
			backend: createMemoryEventsBackend(), role: 'publisher'
		})
		await clockRuntime.events.start()
		await expect(clockRuntime.events.publish('async.clock', {})).rejects.toThrow('EVENTS_CLOCK_INVALID')
		await clockRuntime.events.shutdown()

		const thrownClockRuntime = await createEventsManager({
			clock: {now: () => { throw Promise.reject(new Error('thrown clock rejection')) }} as never,
			backend: createMemoryEventsBackend(), role: 'publisher'
		})
		await thrownClockRuntime.events.start()
		await expect(thrownClockRuntime.events.publish('thrown.clock', {})).rejects.toThrow('EVENTS_CLOCK_INVALID')
		await thrownClockRuntime.events.shutdown()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains rejected promises nested in invalid public data', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		await expect(runtime.events.publish('nested.promise', {
			first: {invalid: Promise.reject(new Error('first nested rejection'))},
			second: {invalid: Promise.reject(new Error('second nested rejection'))}
		})).rejects.toThrow('EVENTS_PAYLOAD_INVALID')
		await runtime.events.shutdown()
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains rejected promises used as extension failure reasons', async() => {
		const runtime = await createEventsManager({
			clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true
		})
		runtime.events.registerConsumer({name: 'nested-reason', eventTypes: ['nested.reason']}, () => {
			throw Promise.reject(new Error('consumer nested reason'))
		})
		await runtime.events.start()
		await expect(runtime.events.publish('nested.reason', {})).resolves.toMatchObject({type: 'nested.reason'})
		expect(runtime.events.getStatus().retriedTotal).toBe(1)
		await runtime.events.shutdown()

		const event = {
			id: 'nested-transport', type: 'nested.reason', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		}
		const kafka = createKafkaEventTransport({
			producer: {send: async() => { throw Promise.reject(new Error('kafka nested reason')) }},
			allowedTopics: ['events.test']
		})
		const nats = createNatsEventTransport({
			publisher: {publish: () => { throw Promise.reject(new Error('nats nested reason')) }},
			allowedSubjects: ['events.test']
		})
		await expect(kafka.deliver(event, {destination: 'kafka', target: 'events.test'}, new AbortController().signal))
			.resolves.toMatchObject({status: 'retryable'})
		await expect(nats.deliver(event, {destination: 'nats', target: 'events.test'}, new AbortController().signal))
			.resolves.toMatchObject({status: 'retryable'})
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains rejected promises across unused extension error metadata', async() => {
		const runtime = await createEventsManager({
			clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true, maxAttempts: 1,
			destinations: [{name: 'error-metadata', kind: 'custom', deliver: async() => {
				throw {
					code: Promise.reject(new Error('error code rejection')),
					permanent: true,
					retryAfterMs: Promise.reject(new Error('unused retry delay rejection'))
				}
			}}]
		})
		runtime.events.registerDefinition({
			type: 'error.metadata', source: 'test', schema,
			binding: {destination: 'error-metadata', target: 'target'}
		})
		await runtime.events.start()
		await runtime.events.publish('error.metadata', {value: 'test'})
		await expect(runtime.admin!.listDeadLetters()).resolves.toEqual([
			expect.objectContaining({failureCode: 'EVENTS_DELIVERY_FAILURE'})
		])
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await runtime.events.shutdown()
	})

	it('keeps Kafka and NATS destinations isolated behind bounded client contracts', async() => {
		const kafkaSend = vi.fn(async() => undefined)
		const natsPublish = vi.fn(async() => undefined)
		const kafka = createKafkaEventTransport({
			producer: {send: kafkaSend},
			allowedTopics: ['events.test']
		})
		const nats = createNatsEventTransport({
			publisher: {publish: natsPublish},
			allowedSubjects: ['events.test']
		})
		const event = Object.freeze({
			id: 'event-1', type: 'test.created', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {value: 'ok'}
		})

		await expect(kafka.deliver(event, {destination: 'kafka', target: 'events.test'}, new AbortController().signal))
			.resolves.toMatchObject({status: 'success'})
		await expect(nats.deliver(event, {destination: 'nats', target: 'events.test'}, new AbortController().signal))
			.resolves.toMatchObject({status: 'success'})
		expect(kafkaSend).toHaveBeenCalledTimes(1)
		expect(natsPublish).toHaveBeenCalledTimes(1)
		await Promise.all([kafka.shutdown!(), nats.shutdown!()])
	})

	it('rejects invalid destination identity before compatibility or subscription side effects', async() => {
		const startConsumer = vi.fn(async() => () => undefined)
		const compatibility = vi.fn(async() => ({compatible: true as const}))
		const backend = createMemoryEventsBackend()
		await expect(createEventsManager({
			clock,
			backend: {...backend, durability: 'durable', compatibility, inbox: backend.inbox},
			role: 'worker',
			destinations: [{
				name: '', kind: 'local', deliver: async() => undefined, startConsumer
			} as never]
		})).rejects.toThrow('EVENTS_DESTINATIONS_INVALID')
		expect(compatibility).not.toHaveBeenCalled()
		expect(startConsumer).not.toHaveBeenCalled()
	})

	it('contains transport lifecycle calls awaited from the active Kafka and NATS send', async() => {
		let kafka!: ReturnType<typeof createKafkaEventTransport>
		let nats!: ReturnType<typeof createNatsEventTransport>
		kafka = createKafkaEventTransport({
			producer: {send: async() => kafka.flush!()},
			allowedTopics: ['events.test'], timeoutMs: 100
		})
		nats = createNatsEventTransport({
			publisher: {publish: async() => nats.shutdown!()},
			allowedSubjects: ['events.test'], timeoutMs: 100
		})
		const event = Object.freeze({
			id: 'event-reentry', type: 'test.created', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {value: 'ok'}
		})

		await expect(Promise.all([
			kafka.deliver(event, {destination: 'kafka', target: 'events.test'}, new AbortController().signal),
			nats.deliver(event, {destination: 'nats', target: 'events.test'}, new AbortController().signal)
		])).resolves.toEqual([
			expect.objectContaining({status: 'success'}),
			expect.objectContaining({status: 'success'})
		])
		await kafka.shutdown!()
	})

	it('keeps external broker shutdown draining after an internal send starts the flight', async() => {
		let enteredKafka!: () => void
		let enteredNats!: () => void
		let releaseKafka!: () => void
		let releaseNats!: () => void
		const kafkaEntered = new Promise<void>((resolve) => { enteredKafka = resolve })
		const natsEntered = new Promise<void>((resolve) => { enteredNats = resolve })
		const kafkaGate = new Promise<void>((resolve) => { releaseKafka = resolve })
		const natsGate = new Promise<void>((resolve) => { releaseNats = resolve })
		let kafka!: ReturnType<typeof createKafkaEventTransport>
		let nats!: ReturnType<typeof createNatsEventTransport>
		kafka = createKafkaEventTransport({
			producer: {send: async() => { enteredKafka(); await kafka.shutdown!(); await kafkaGate }},
			allowedTopics: ['events.test'], timeoutMs: 100
		})
		nats = createNatsEventTransport({
			publisher: {publish: async() => { enteredNats(); await nats.shutdown!(); await natsGate }},
			allowedSubjects: ['events.test'], timeoutMs: 100
		})
		const event = Object.freeze({
			id: 'event-external-drain', type: 'test.created', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		})
		const deliveries = Promise.all([
			kafka.deliver(event, {destination: 'kafka', target: 'events.test'}, new AbortController().signal),
			nats.deliver(event, {destination: 'nats', target: 'events.test'}, new AbortController().signal)
		])
		await Promise.all([kafkaEntered, natsEntered])
		let kafkaSettled = false
		let natsSettled = false
		const shutdowns = Promise.all([
			kafka.shutdown!().finally(() => { kafkaSettled = true }),
			nats.shutdown!().finally(() => { natsSettled = true })
		])
		await Promise.resolve()
		expect([kafkaSettled, natsSettled]).toEqual([false, false])
		releaseKafka(); releaseNats()
		await expect(Promise.all([deliveries, shutdowns])).resolves.toEqual([
			[expect.objectContaining({status: 'success'}), expect.objectContaining({status: 'success'})],
			[undefined, undefined]
		])
	})

	it('does not grant internal shutdown semantics to detached broker work', async() => {
		let trigger!: () => void
		let release!: () => void
		const triggerGate = new Promise<void>((resolve) => { trigger = resolve })
		const sendGate = new Promise<void>((resolve) => { release = resolve })
		let kafkaCalls = 0
		let natsCalls = 0
		let kafkaShutdown!: Promise<void>
		let natsShutdown!: Promise<void>
		let kafka!: ReturnType<typeof createKafkaEventTransport>
		let nats!: ReturnType<typeof createNatsEventTransport>
		kafka = createKafkaEventTransport({
			producer: {send: async() => {
				kafkaCalls++
				if (kafkaCalls === 1) { kafkaShutdown = triggerGate.then(() => kafka.shutdown!()); return }
				await sendGate
			}},
			allowedTopics: ['events.test']
		})
		nats = createNatsEventTransport({
			publisher: {publish: async() => {
				natsCalls++
				if (natsCalls === 1) { natsShutdown = triggerGate.then(() => nats.shutdown!()); return }
				await sendGate
			}},
			allowedSubjects: ['events.test']
		})
		const event = Object.freeze({
			id: 'detached-broker-shutdown', type: 'test.created', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		})
		const binding = {destination: 'broker', target: 'events.test'}
		await Promise.all([
			kafka.deliver(event, binding, new AbortController().signal),
			nats.deliver(event, binding, new AbortController().signal)
		])
		const deliveries = Promise.all([
			kafka.deliver(event, binding, new AbortController().signal),
			nats.deliver(event, binding, new AbortController().signal)
		])
		trigger()
		let settled = false
		const shutdowns = Promise.all([kafkaShutdown, natsShutdown]).finally(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release()
		await Promise.all([deliveries, shutdowns])
	})

	it('rejects insecure or private HTTP webhook targets before transport I/O', async() => {
		expect(() => createHttpWebhookEventTransport({allowedOrigins: ['http://example.com']}))
			.toThrow('EVENTS_HTTP_ORIGINS_INVALID')
		const destination = createHttpWebhookEventTransport({allowedOrigins: ['https://localhost']})
		const event = Object.freeze({
			id: 'event-1', type: 'test.created', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {value: 'ok'}
		})
		await expect(destination.deliver(
			event,
			{destination: 'http', target: 'https://localhost/hook'},
			new AbortController().signal
		)).resolves.toMatchObject({status: 'permanent-failure'})
	})

	it('rechecks HTTP abort state after installing the request listener', async() => {
		const destination = createHttpWebhookEventTransport({allowedOrigins: ['https://8.8.8.8'], timeoutMs: 10})
		let abortedReads = 0
		const signal = {
			get aborted() { abortedReads++; return abortedReads > 1 },
			addEventListener: vi.fn(), removeEventListener: vi.fn()
		} as unknown as AbortSignal
		await expect(destination.deliver({
			id: 'abort-race', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		}, {destination: 'http', target: 'https://8.8.8.8/hook'}, signal))
			.resolves.toMatchObject({status: 'retryable'})
		expect(abortedReads).toBeGreaterThanOrEqual(2)
		expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), {once: true})
		expect(signal.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
	})

	it('keeps transient HTTP DNS failures retryable', async() => {
		const destination = createHttpWebhookEventTransport({allowedOrigins: ['https://events.invalid']})
		await expect(destination.deliver({
			id: 'event-1', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		}, {destination: 'http', target: 'https://events.invalid/hook'}, new AbortController().signal))
			.resolves.toMatchObject({status: 'retryable'})
	})

	it('performs only read-only PostgreSQL compatibility queries at bootstrap', async() => {
		const queries: string[] = []
		const client = {query: vi.fn(async(sql: string) => {
			queries.push(sql)
			if (sql.includes('to_regclass')) return {rows: [{outbox: 'events_outbox', inbox: 'events_inbox'}]}
			if (sql.includes('information_schema.columns')) return {rows: [
				...Object.entries({event_id: 'text', envelope_json: 'jsonb', status: 'text', attempts: 'int4', last_error: 'text',
					next_attempt_at: 'timestamptz', processing_started_at: 'timestamptz', processing_by: 'text',
					dispatched_at: 'timestamptz', created_at: 'timestamptz', updated_at: 'timestamptz', attempts_log_json: 'jsonb'})
					.map(([column_name, udt_name]) => ({table_name: 'events_outbox', column_name, udt_name})),
				...Object.entries({consumer: 'text', event_id: 'text', record_json: 'jsonb'})
					.map(([column_name, udt_name]) => ({table_name: 'events_inbox', column_name, udt_name}))
			]}
			if (sql.includes('table_constraints')) return {rows: [
				{table_name: 'events_outbox', constraint_type: 'PRIMARY KEY', column_name: 'event_id', ordinal_position: 1},
				{table_name: 'events_inbox', constraint_type: 'PRIMARY KEY', column_name: 'consumer', ordinal_position: 1},
				{table_name: 'events_inbox', constraint_type: 'PRIMARY KEY', column_name: 'event_id', ordinal_position: 2}
			]}
			if (sql.includes('pg_indexes')) return {rows: [
				{tablename: 'events_outbox', indexdef: 'CREATE INDEX due ON events_outbox (status, next_attempt_at)'},
				{tablename: 'events_outbox', indexdef: 'CREATE INDEX processing ON events_outbox (status, processing_started_at)'}
			]}
			return {rows: [], rowCount: 0}
		})}
		const runtime = await createEventsManager({
			clock,
			backend: createPostgresEventsBackend({client}),
			role: 'publisher'
		})

		expect(queries.length).toBeGreaterThan(0)
		expect(queries.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true)
		expect(queries.some((sql) => sql.includes('udt_name'))).toBe(true)
		expect(queries.some((sql) => sql.includes('key_column_usage'))).toBe(true)
		await runtime.events.shutdown()
	})

	it('rejects PostgreSQL prefixes that would be silently truncated', () => {
		const unsafe = `e${'x'.repeat(56)}`
		expect(() => createPostgresEventsBackend({client: {query: vi.fn()}, tablePrefix: unsafe}))
			.toThrow('EVENTS_TABLE_PREFIX_INVALID')
		expect(() => createPostgresEventMigrations(unsafe)).toThrow('EVENTS_TABLE_PREFIX_INVALID')
		expect(() => createPostgresEventMigrations('TenantA')).toThrow('EVENTS_TABLE_PREFIX_INVALID')
		expect(() => createPostgresEventMigrations(`e${'x'.repeat(55)}`)).not.toThrow()
	})

	it('contains rejected promises supplied as migration prefixes', async() => {
		expect(() => createPostgresEventMigrations(Promise.reject(new Error('migration prefix')) as never))
			.toThrow('EVENTS_TABLE_PREFIX_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('rejects accessor-backed store factory options without invoking them', () => {
		const memoryGetter = vi.fn(() => 1)
		const memoryOptions = Object.defineProperty({}, 'maxRecords', {enumerable: true, get: memoryGetter})
		expect(() => createMemoryEventsBackend(memoryOptions)).toThrow('EVENTS_BACKEND_OPTIONS_INVALID')

		const clientGetter = vi.fn(() => ({query: vi.fn()}))
		const postgresOptions = Object.defineProperty({}, 'client', {enumerable: true, get: clientGetter})
		expect(() => createPostgresEventsBackend(postgresOptions as never)).toThrow('EVENTS_POSTGRES_CLIENT_INVALID')
		const bindGetter = vi.fn(() => Function.prototype.bind)
		const query = Object.defineProperty(vi.fn(), 'bind', {get: bindGetter})
		expect(() => createPostgresEventsBackend({client: {query} as never})).not.toThrow()
		expect(memoryGetter).not.toHaveBeenCalled()
		expect(clientGetter).not.toHaveBeenCalled()
		expect(bindGetter).not.toHaveBeenCalled()
	})

	it('contains rejected promises supplied in synchronous transport and store options', async() => {
		expect(() => createMemoryEventsBackend({
			maxRecords: Promise.reject(new Error('memory record option')),
			maxBytes: Promise.reject(new Error('memory byte option'))
		} as never))
			.toThrow('EVENTS_BACKEND_OPTIONS_INVALID')
		expect(() => createKafkaEventTransport({
			producer: {send: async() => undefined}, allowedTopics: Promise.reject(new Error('topic option')) as never,
			timeoutMs: Promise.reject(new Error('transport option')) as never
		})).toThrow('EVENTS_KAFKA_TOPICS_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('supports PostgreSQL clients whose query method is inherited through multiple prototypes', async() => {
		const query = vi.fn(async() => ({rows: [{count: '0'}], rowCount: 0}))
		const client = Object.create(Object.create({query})) as never
		const backend = createPostgresEventsBackend({client})
		await expect(backend.outbox.queuedCount()).resolves.toBe(0)
		expect(query).toHaveBeenCalledTimes(1)
	})

	it('persists retry state and recovers without duplicating completed consumers', async() => {
		let now = Date.now()
		const deliver = vi.fn()
			.mockResolvedValueOnce({status: 'retryable'})
			.mockResolvedValue({status: 'success'})
		const runtime = await createEventsManager({
			clock: {now: () => now},
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true,
			destinations: [{name: 'remote', kind: 'custom', deliver}]
		})
		const consumer = vi.fn()
		runtime.events.registerDefinition({
			type: 'retry.event', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		runtime.events.registerConsumer({name: 'retry-consumer', eventTypes: ['retry.event']}, consumer)
		await runtime.events.start()
		await runtime.events.publish('retry.event', {value: 'first'})
		expect(runtime.events.getStatus().retriedTotal).toBe(1)

		now += 1_000
		await runtime.events.publish('retry.event', {value: 'second'})
		expect(deliver).toHaveBeenCalledTimes(3)
		expect(consumer).toHaveBeenCalledTimes(2)
		expect(runtime.events.getStatus()).toMatchObject({queuedEvents: 0, backendState: 'healthy'})
		await runtime.events.shutdown()
	})

	it('does not dead-letter failures with malformed permanent metadata', async() => {
		const backend = createMemoryEventsBackend()
		const runtime = await createEventsManager({
			clock,
			backend,
			role: 'combined',
			inline: true,
			destinations: [{name: 'remote', kind: 'custom', deliver: async() => {
				throw Object.assign(new Error('temporary delivery failure'), {permanent: 'false'})
			}}]
		})
		runtime.events.registerDefinition({
			type: 'metadata.retry', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		await runtime.events.start()
		await runtime.events.publish('metadata.retry', {value: 'retry'})
		expect(runtime.events.getStatus()).toMatchObject({retriedTotal: 1, deadLetteredTotal: 0})
		await runtime.events.shutdown()
	})

	it('dead-letters permanent destination failures exactly once', async() => {
		const backend = createMemoryEventsBackend()
		const runtime = await createEventsManager({
			clock,
			backend,
			role: 'combined',
			inline: true,
			destinations: [{
				name: 'remote', kind: 'custom',
				deliver: async() => ({status: 'permanent-failure'})
			}]
		})
		runtime.events.registerDefinition({
			type: 'dead.event', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		await runtime.events.start()
		await runtime.events.publish('dead.event', {value: 'dead'})
		expect(runtime.events.getStatus().deadLetteredTotal).toBe(1)
		expect(await runtime.admin!.listDeadLetters()).toHaveLength(1)
		await runtime.events.flush()
		expect(runtime.events.getStatus().deadLetteredTotal).toBe(1)
		await runtime.events.shutdown()
	})

	it('does not invent admin capabilities for a custom core backend', async() => {
		const memory = createMemoryEventsBackend()
		const runtime = await createEventsManager({
			clock,
			backend: {durability: 'ephemeral', outbox: memory.outbox, inbox: memory.inbox},
			role: 'publisher'
		})
		expect(runtime.admin).toBeUndefined()
		expect(runtime.transactional).toBeUndefined()
		await runtime.events.shutdown()
	})

	it('injects and extracts private W3C context through the explicit bridge', async() => {
		const extracted = vi.fn(async(_carrier: Record<string, string>, callback: () => unknown) => callback())
		const inSpan = vi.fn(async(_name: string, callback: () => unknown) => callback())
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true
		})
		runtime.events.registerDefinition({type: 'trace.event', source: 'test', schema})
		runtime.events.registerConsumer({name: 'trace-consumer', eventTypes: ['trace.event']}, async() => undefined)
		wireEventsObservability(runtime.events, {tracer: {
			injectHeaders(carrier: Record<string, string>) { carrier.traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
			withExtractedHeaders: extracted,
			inSpan
		} as never})
		await runtime.events.start()
		const envelope = await runtime.events.publish('trace.event', {value: 'ok'})
		expect(envelope).not.toHaveProperty('traceparent')
		expect(extracted).toHaveBeenCalledWith(
			expect.objectContaining({traceparent: expect.stringContaining('00-')}),
			expect.any(Function)
		)
		expect(inSpan).toHaveBeenCalledWith('events.publish', expect.any(Function), {kind: 'producer'})
		expect(inSpan).toHaveBeenCalledWith('events.consume', expect.any(Function), {kind: 'consumer'})
		await runtime.events.shutdown()
	})

	it('isolates a throwing tracing bridge without executing publication twice', async() => {
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'publisher'
		})
		const parse = vi.fn((value: unknown) => value as {value: string})
		runtime.events.registerDefinition({type: 'isolated.event', source: 'test', schema: {parse}})
		wireEventsObservability(runtime.events, {tracer: {
			inSpan: vi.fn(async() => { throw new Error('tracer unavailable') })
		} as never})
		await runtime.events.start()
		await expect(runtime.events.publish('isolated.event', {value: 'ok'}))
			.resolves.toMatchObject({type: 'isolated.event'})
		expect(parse).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
	})

	it('captures custom backend methods once at bootstrap', async() => {
		const backend = createMemoryEventsBackend()
		const runtime = await createEventsManager({clock, backend, role: 'publisher'})
		backend.outbox.append = async() => { throw new Error('mutated backend') }
		await runtime.events.start()
		await expect(runtime.events.publish('captured.event', {value: 'ok'}))
			.resolves.toMatchObject({type: 'captured.event'})
		await runtime.events.shutdown()
	})

	it('rejects accessor-backed backend fields without invoking them', async() => {
		const getter = vi.fn(() => createMemoryEventsBackend().outbox)
		const backend = Object.defineProperty({durability: 'ephemeral'}, 'outbox', {
			enumerable: true, get: getter
		})
		await expect(createEventsManager({clock, backend: backend as never, role: 'publisher'}))
			.rejects.toThrow('EVENTS_EXTENSION_INVALID')
		expect(getter).not.toHaveBeenCalled()
	})

	it('rejects cyclic and accessor-backed batch inputs without executing accessors', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		await expect(runtime.events.publish('cyclic.event', cyclic)).rejects.toThrow('EVENTS_PAYLOAD_INVALID')

		const getter = vi.fn(() => 'getter.event')
		const request = Object.defineProperty({payload: {}}, 'type', {enumerable: true, get: getter})
		await expect(runtime.events.publishMany([request as never])).rejects.toThrow('EVENTS_BATCH_INVALID')
		expect(getter).not.toHaveBeenCalled()
		await expect(runtime.events.publishMany([{
			type: 'first.batch', payload: {nested: {invalid: Promise.reject(new Error('first batch rejection'))}}
		}, {
			type: 'second.batch', payload: {nested: {invalid: Promise.reject(new Error('second batch rejection'))}}
		}] as never)).rejects.toThrow('EVENTS_PAYLOAD_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await runtime.events.shutdown()
	})

	it('contains nested registration rejections before definition or consumer validation short-circuits', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		expect(() => runtime.events.registerDefinition({
			type: 'invalid.definition', source: 'test',
			schema: {parse: Promise.reject(new Error('definition parser rejection'))} as never,
			defaultHeaders: {nested: {invalid: Promise.reject(new Error('definition header rejection'))}}
		})).toThrow('EVENTS_EXTENSION_INVALID')
		expect(() => runtime.events.registerConsumer({
			name: 'invalid-consumer',
			eventTypes: [
				Promise.reject(new Error('first event type rejection')),
				Promise.reject(new Error('second event type rejection'))
			] as never
		}, Promise.reject(new Error('consumer handler rejection')) as never)).toThrow('EVENTS_CONSUMER_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await runtime.events.shutdown()
	})

	it('rejects unsafe numeric runtime bounds before starting timers', async() => {
		await expect(createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'worker', pollIntervalMs: 0}))
			.rejects.toThrow('EVENTS_OPTIONS_INVALID')
		await expect(createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'worker', maxConcurrent: 33}))
			.rejects.toThrow('EVENTS_OPTIONS_INVALID')
		await expect(createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'worker', operationTimeoutMs: Number.NaN}))
			.rejects.toThrow('EVENTS_OPTIONS_INVALID')
	})

	it('rejects malformed or oversized publication metadata before persistence', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		for (const [field, maximum] of [
			['subject', 256], ['aggregateId', 256], ['partitionKey', 256],
			['correlationId', 128], ['causationId', 128], ['tenantId', 128]
		] as const) {
			await expect(runtime.events.publish('metadata.event', {}, {[field]: 'x'.repeat(maximum + 1)} as never))
				.rejects.toThrow('EVENTS_OPTIONS_INVALID')
		}
		await expect(runtime.events.publish('metadata.event', {}, {subject: 42} as never))
			.rejects.toThrow('EVENTS_OPTIONS_INVALID')
		await expect(runtime.admin!.listOutbox()).resolves.toHaveLength(0)
		await runtime.events.shutdown()
	})

	it('bounds extension prototype traversal against non-terminating proxy chains', async() => {
		let prototypeReads = 0
		const makePrototype = (): object => new Proxy({}, {
			getOwnPropertyDescriptor: () => undefined,
			getPrototypeOf: () => { prototypeReads++; return makePrototype() }
		})
		await expect(createEventsManager({
			clock: makePrototype() as never,
			backend: createMemoryEventsBackend(),
			role: 'publisher'
		})).rejects.toThrow('EVENTS_EXTENSION_INVALID')
		expect(prototypeReads).toBeLessThanOrEqual(32)
	})

	it('rejects backend claims that exceed the configured concurrency bound', async() => {
		const backend = createMemoryEventsBackend()
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, outbox: {...backend.outbox, claimDue: async() => [{}, {}] as never}},
			role: 'worker',
			maxConcurrent: 1
		})
		await expect(runtime.events.start()).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		expect(runtime.events.getStatus().state).toBe('idle')
		await runtime.events.shutdown()
	})

	it('rejects duplicate backend claims before either copy can cause side effects', async() => {
		const backend = createMemoryEventsBackend()
		const deliver = vi.fn(async() => undefined)
		const runtime = await createEventsManager({
			clock: {now: () => 0},
			backend: {...backend, outbox: {...backend.outbox, claimDue: async({owner}: {owner: string}) => {
				const record = {
					envelope: {
						id: 'duplicate-claim', type: 'test.created', specVersion: '1.0', source: 'test',
						occurredAt: new Date(0).toISOString(), headers: {}, payload: {}
					},
					binding: {destination: 'remote', target: 'events'},
					status: 'dispatching', attempts: 1, availableAt: 0, createdAt: 0, updatedAt: 0,
					lease: {owner, expiresAt: 30_000, generation: 1}
				}
				return [record, record] as never
			}}},
			role: 'worker', maxConcurrent: 2,
			destinations: [{name: 'remote', kind: 'custom', deliver}]
		})
		await expect(runtime.events.start()).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		expect(deliver).not.toHaveBeenCalled()
		await runtime.events.shutdown()
	})

	it('rejects claimed records without the current dispatch lease before side effects', async() => {
		const backend = createMemoryEventsBackend()
		const handler = vi.fn()
		const complete = vi.fn(async() => true)
		const runtime = await createEventsManager({
			clock: {now: () => 0},
			backend: {...backend, outbox: {
				...backend.outbox,
				claimDue: async({owner}: {owner: string}) => [{
					envelope: {
						id: 'foreign-lease', type: 'test.created', specVersion: '1.0', source: 'test',
						occurredAt: new Date(0).toISOString(), headers: {}, payload: {}
					},
					status: 'dispatching', attempts: 1, availableAt: 0, createdAt: 0, updatedAt: 0,
					lease: {owner: `${owner}-other`, expiresAt: 30_000, generation: 1}
				}] as never,
				complete
			}},
			role: 'worker'
		})
		runtime.events.registerConsumer({name: 'test-consumer', eventTypes: ['test.created']}, handler)
		await expect(runtime.events.start()).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		expect(handler).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
		await runtime.events.shutdown()
	})

	it('rejects claimed records without the full requested lease runway', async() => {
		const backend = createMemoryEventsBackend()
		const handler = vi.fn()
		const runtime = await createEventsManager({
			clock: {now: () => 1_000},
			backend: {...backend, outbox: {...backend.outbox, claimDue: async({owner}: {owner: string}) => [{
				envelope: {
					id: 'short-lease', type: 'test.created', specVersion: '1.0', source: 'test',
					occurredAt: new Date(1_000).toISOString(), headers: {}, payload: {}
				},
				status: 'dispatching', attempts: 1, availableAt: 1_000, createdAt: 1_000, updatedAt: 1_000,
				lease: {owner, expiresAt: 30_999, generation: 1}
			}] as never}},
			role: 'worker'
		})
		runtime.events.registerConsumer({name: 'test-consumer', eventTypes: ['test.created']}, handler)
		await expect(runtime.events.start()).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		expect(handler).not.toHaveBeenCalled()
		await runtime.events.shutdown()
	})

	it('contains clock failures raised from maintenance timer callbacks', async() => {
		vi.useFakeTimers()
		try {
			let failed = false
			const runtime = await createEventsManager({
				clock: {now: () => { if (failed) throw new Error('clock offline'); return Date.now() }},
				backend: createMemoryEventsBackend(),
				role: 'publisher',
				maintenanceIntervalMs: 100
			})
			await runtime.events.start()
			failed = true
			await vi.advanceTimersByTimeAsync(100)
			expect(runtime.events.getStatus().state).toBe('running')
			failed = false
			await runtime.events.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('keeps maintenance purge work single-flight while the backend is slow', async() => {
		vi.useFakeTimers()
		try {
			const backend = createMemoryEventsBackend()
			let finish!: () => void
			const first = new Promise<void>((resolve) => { finish = resolve })
			const purgeExpired = vi.spyOn(backend.outbox, 'purgeExpired')
				.mockImplementationOnce(async() => { await first; return 0 })
				.mockResolvedValue(0)
			const runtime = await createEventsManager({
				clock,
				backend,
				role: 'publisher',
				maintenanceIntervalMs: 100
			})
			await runtime.events.start()
			await vi.advanceTimersByTimeAsync(500)
			expect(purgeExpired).toHaveBeenCalledTimes(1)
			finish()
			await vi.advanceTimersByTimeAsync(0)
			await vi.advanceTimersByTimeAsync(100)
			expect(purgeExpired).toHaveBeenCalledTimes(2)
			await runtime.events.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('contains shutdown awaited from maintenance backend work', async() => {
		vi.useFakeTimers()
		try {
			const backend = createMemoryEventsBackend()
			let runtime!: Awaited<ReturnType<typeof createEventsManager>>
			vi.spyOn(backend.outbox, 'purgeExpired').mockImplementationOnce(async() => {
				await runtime.events.shutdown()
				return 0
			})
			runtime = await createEventsManager({
				clock: {now: () => Date.now()}, backend, role: 'publisher', maintenanceIntervalMs: 100
			})
			await runtime.events.start()
			await vi.advanceTimersByTimeAsync(100)
			await vi.advanceTimersByTimeAsync(0)
			expect(runtime.events.getStatus().state).toBe('closed')
		} finally { vi.useRealTimers() }
	})

	it('aborts consumer work as soon as its inbox lease is lost', async() => {
		vi.useFakeTimers()
		try {
			const backend = createMemoryEventsBackend()
			const renew = vi.fn(async() => false)
			const retry = vi.spyOn(backend.outbox, 'retry')
			const runtime = await createEventsManager({
				clock: {now: () => Date.now()},
				backend: {...backend, inbox: {...backend.inbox!, renew}},
				role: 'combined',
				inline: true
			})
			let started!: () => void
			const handlerStarted = new Promise<void>((resolve) => { started = resolve })
			let observedAbort = false
			runtime.events.registerConsumer({name: 'lease-consumer', eventTypes: ['lease.event']}, async(_event, context) => {
				started()
				await new Promise<void>((resolve) => {
					if (context.signal.aborted) { observedAbort = true; resolve(); return }
					context.signal.addEventListener('abort', () => { observedAbort = true; resolve() }, {once: true})
				})
			})
			await runtime.events.start()
			const published = runtime.events.publish('lease.event', {})
			await handlerStarted
			await vi.advanceTimersByTimeAsync(10_000)
			await published
			expect(observedAbort).toBe(true)
			expect(retry).toHaveBeenCalledTimes(1)
			await runtime.events.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('contains consumer abort-listener failures during shutdown', async() => {
		let entered!: () => void
		const started = new Promise<void>((resolve) => { entered = resolve })
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined', inline: true
		})
		runtime.events.registerDefinition({type: 'abort.listener', source: 'test', schema})
		runtime.events.registerConsumer({name: 'abort-listener', eventTypes: ['abort.listener']}, async(_event, context) => {
			entered()
			await new Promise<void>((resolve) => {
				context.signal.addEventListener('abort', () => { throw new Error('hostile abort listener') })
				context.signal.addEventListener('abort', () => resolve(), {once: true})
			})
		})
		await runtime.events.start()
		const publication = runtime.events.publish('abort.listener', {value: 'ok'})
		await started
		await expect(runtime.events.shutdown()).resolves.toBeUndefined()
		await expect(publication).resolves.toMatchObject({type: 'abort.listener'})
	})

	it('aborts consumer work before a physically hung lease renewal can expire', async() => {
		vi.useFakeTimers()
		try {
			const backend = createMemoryEventsBackend()
			let finishInboxRenew!: (value: boolean) => void
			let finishOutboxRenew!: (value: boolean) => void
			const renew = vi.fn(() => new Promise<boolean>((resolve) => { finishInboxRenew = resolve }))
			const renewOutbox = vi.fn(() => new Promise<boolean>((resolve) => { finishOutboxRenew = resolve }))
			const retry = vi.spyOn(backend.outbox, 'retry')
			const runtime = await createEventsManager({
				clock: {now: () => Date.now()},
				backend: {...backend, outbox: {...backend.outbox, renew: renewOutbox}, inbox: {...backend.inbox!, renew}},
				role: 'combined', inline: true, operationTimeoutMs: 120_000
			})
			let observedAbort = false
			runtime.events.registerConsumer({name: 'hung-renew-consumer', eventTypes: ['hung-renew.event']}, async(_event, context) => {
				await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => {
					observedAbort = true; resolve()
				}, {once: true}))
			})
			await runtime.events.start()
			const published = runtime.events.publish('hung-renew.event', {})
			await vi.advanceTimersByTimeAsync(20_001)
			expect(renew).toHaveBeenCalledTimes(1)
			expect(renewOutbox).toHaveBeenCalledTimes(1)
			expect(observedAbort).toBe(true)
			finishInboxRenew(true); finishOutboxRenew(true)
			await vi.advanceTimersByTimeAsync(0)
			await published
			expect(retry).toHaveBeenCalledTimes(1)
			await runtime.events.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('does not acknowledge an event when a backend CAS returns a truthy non-boolean', async() => {
		const backend = createMemoryEventsBackend()
		const retry = vi.spyOn(backend.outbox, 'retry')
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, outbox: {...backend.outbox, complete: async() => 'false' as never}},
			role: 'combined',
			inline: true
		})
		runtime.events.registerConsumer({name: 'cas-consumer', eventTypes: ['cas.event']}, async() => undefined)
		await runtime.events.start()
		await runtime.events.publish('cas.event', {})
		expect(retry).toHaveBeenCalledTimes(1)
		expect(runtime.events.getStatus().retriedTotal).toBe(1)
		await runtime.events.shutdown()
	})

	it('rejects malformed inbox and consumer outcomes before committing side effects', async() => {
		const malformedClaimBackend = createMemoryEventsBackend()
		const claimRetry = vi.spyOn(malformedClaimBackend.outbox, 'retry')
		const handler = vi.fn()
		const malformedClaimRuntime = await createEventsManager({
			clock,
			backend: {...malformedClaimBackend, inbox: {...malformedClaimBackend.inbox!, claim: async() => 'owned' as never}},
			role: 'combined',
			inline: true
		})
		malformedClaimRuntime.events.registerConsumer({name: 'claim-consumer', eventTypes: ['claim.event']}, handler)
		await malformedClaimRuntime.events.start()
		await malformedClaimRuntime.events.publish('claim.event', {})
		expect(handler).not.toHaveBeenCalled()
		expect(claimRetry).toHaveBeenCalledTimes(1)
		await malformedClaimRuntime.events.shutdown()

		const malformedOutcomeBackend = createMemoryEventsBackend()
		const outcomeRetry = vi.spyOn(malformedOutcomeBackend.outbox, 'retry')
		const malformedOutcomeRuntime = await createEventsManager({
			clock,
			backend: malformedOutcomeBackend,
			role: 'combined',
			inline: true
		})
		malformedOutcomeRuntime.events.registerConsumer(
			{name: 'outcome-consumer', eventTypes: ['outcome.event']},
			async() => ({outcome: 'accepted'} as never)
		)
		await malformedOutcomeRuntime.events.start()
		await malformedOutcomeRuntime.events.publish('outcome.event', {})
		expect(outcomeRetry).toHaveBeenCalledTimes(1)
		await malformedOutcomeRuntime.events.shutdown()
	})

	it('treats malformed destination results as failures instead of successful delivery', async() => {
		const backend = createMemoryEventsBackend()
		const complete = vi.spyOn(backend.outbox, 'complete')
		const retry = vi.spyOn(backend.outbox, 'retry')
		const runtime = await createEventsManager({
			clock,
			backend,
			role: 'combined',
			inline: true,
			destinations: [{name: 'remote', kind: 'custom', deliver: async() => ({status: 'accepted'} as never)}]
		})
		runtime.events.registerDefinition({
			type: 'delivery.event', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		await runtime.events.start()
		await runtime.events.publish('delivery.event', {})
		expect(complete).not.toHaveBeenCalled()
		expect(retry).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
	})

	it('does not accept malformed durable compatibility attestations', async() => {
		const backend = createMemoryEventsBackend()
		await expect(createEventsManager({
			clock,
			backend: {...backend, durability: 'durable', compatibility: {check: async() => ({compatible: 'yes'} as never)}},
			role: 'worker'
		})).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		await expect(createEventsManager({
			clock,
			backend: {...backend, durability: 'durable', compatibility: {check: () => {
				throw Promise.reject(new Error('compatibility nested reason'))
			}} as never},
			role: 'worker'
		})).rejects.toBeInstanceOf(Promise)
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('does not report a retry when the outbox lease compare-and-set fails', async() => {
		const backend = createMemoryEventsBackend()
		const retry = vi.fn(async() => false)
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, outbox: {...backend.outbox, retry}},
			role: 'combined',
			inline: true,
			destinations: [{name: 'remote', kind: 'custom', deliver: async() => ({status: 'retryable'})}]
		})
		runtime.events.registerDefinition({
			type: 'lease.event', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		await runtime.events.start()
		await expect(runtime.events.publish('lease.event', {value: 'lost'})).rejects.toThrow('EVENTS_OUTBOX_LEASE_LOST')
		expect(retry).toHaveBeenCalledTimes(1)
		expect(runtime.events.getStatus().retriedTotal).toBe(0)
		await runtime.events.shutdown()
	})

	it('does not schedule a retry while a timed-out physical delivery is still running', async() => {
		let finish!: () => void
		let settled = false
		const backend = createMemoryEventsBackend()
		const retry = vi.spyOn(backend.outbox, 'retry')
		const runtime = await createEventsManager({
			clock,
			backend,
			role: 'combined',
			inline: true,
			operationTimeoutMs: 100,
			destinations: [{name: 'remote', kind: 'custom', deliver: () => new Promise<void>((resolve) => { finish = resolve })}]
		})
		runtime.events.registerDefinition({
			type: 'slow.event', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		await runtime.events.start()
		const publication = runtime.events.publish('slow.event', {value: 'slow'}).finally(() => { settled = true })
		await new Promise((resolve) => setTimeout(resolve, 125))
		expect(settled).toBe(false)
		expect(retry).not.toHaveBeenCalled()
		finish()
		await publication
		await runtime.events.shutdown()
	})

	it('keeps free dispatch slots available while another physical delivery is still running', async() => {
		let finishFirst!: () => void
		const firstDelivery = new Promise<void>((resolve) => { finishFirst = resolve })
		const deliver = vi.fn(async(event: {payload: {value: string}}) => {
			if (event.payload.value === 'first') await firstDelivery
		})
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true,
			pollIntervalMs: 10,
			operationTimeoutMs: 100,
			maxConcurrent: 2,
			destinations: [{name: 'remote', kind: 'custom', deliver}]
		})
		runtime.events.registerDefinition({
			type: 'parallel.event', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		await runtime.events.start()
		const firstPublication = runtime.events.publish('parallel.event', {value: 'first'})
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
		await runtime.events.publish('parallel.event', {value: 'second'})
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2), {timeout: 250})
		finishFirst()
		await firstPublication
		await runtime.events.shutdown()
	})

	it('fences reentrant start and shutdown calls from extensions', async() => {
		let runtime!: Awaited<ReturnType<typeof createEventsManager>>
		let nestedStart!: Promise<void>
		const startConsumer = vi.fn(async() => {
			nestedStart = runtime.events.start()
			return async() => undefined
		})
		runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'worker',
			destinations: [{name: 'input', kind: 'custom', deliver: async() => undefined, startConsumer}]
		})
		await runtime.events.start()
		await nestedStart
		expect(startConsumer).toHaveBeenCalledTimes(1)
		await runtime.events.shutdown()
		expect(runtime.events.getStatus().state).toBe('closed')
	})

	it('contains awaited lifecycle re-entry without weakening external single-flight fencing', async() => {
		let runtime!: Awaited<ReturnType<typeof createEventsManager>>
		let releaseStop!: () => void
		const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
		const startConsumer = vi.fn(async() => {
			await runtime.events.start()
			return async() => {
				await runtime.events.shutdown()
				await stopGate
			}
		})
		runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'worker',
			destinations: [{name: 'input', kind: 'custom', deliver: async() => undefined, startConsumer}]
		})
		await runtime.events.start()
		expect(startConsumer).toHaveBeenCalledTimes(1)
		const firstShutdown = runtime.events.shutdown()
		let externalSettled = false
		const externalShutdown = runtime.events.shutdown().finally(() => { externalSettled = true })
		await Promise.resolve()
		expect(externalSettled).toBe(false)
		releaseStop()
		await Promise.all([firstShutdown, externalShutdown])
		expect(runtime.events.getStatus().state).toBe('closed')
	})

	it('contains shutdown awaited from active consumer work while external shutdown still drains', async() => {
		let runtime!: Awaited<ReturnType<typeof createEventsManager>>
		let entered!: () => void
		let release!: () => void
		const handlerEntered = new Promise<void>((resolve) => { entered = resolve })
		const handlerGate = new Promise<void>((resolve) => { release = resolve })
		let internalReturned = false
		runtime = await createEventsManager({
			clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true
		})
		runtime.events.registerConsumer({name: 'reentrant-shutdown', eventTypes: ['shutdown.event']}, async() => {
			entered()
			await runtime.events.shutdown()
			internalReturned = true
			await handlerGate
		})
		await runtime.events.start()
		const publication = runtime.events.publish('shutdown.event', {})
		await handlerEntered
		await vi.waitFor(() => expect(internalReturned).toBe(true))
		let externalSettled = false
		const externalShutdown = runtime.events.shutdown().finally(() => { externalSettled = true })
		await Promise.resolve()
		expect(externalSettled).toBe(false)
		release()
		await Promise.all([publication, externalShutdown])
		expect(runtime.events.getStatus().state).toBe('closed')
	})

	it('does not grant internal shutdown semantics to detached manager work', async() => {
		let trigger!: () => void
		let release!: () => void
		let deliverEntered!: () => void
		const triggerGate = new Promise<void>((resolve) => { trigger = resolve })
		const deliveryGate = new Promise<void>((resolve) => { release = resolve })
		const deliveryStarted = new Promise<void>((resolve) => { deliverEntered = resolve })
		let detachedShutdown!: Promise<void>
		const runtime = await createEventsManager({
			clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true,
			destinations: [{
				name: 'slow', kind: 'custom',
				deliver: async() => { deliverEntered(); await deliveryGate }
			}]
		})
		runtime.events.registerConsumer({name: 'detached', eventTypes: ['schedule.shutdown']}, async() => {
			detachedShutdown = triggerGate.then(() => runtime.events.shutdown())
		})
		runtime.events.registerDefinition({
			type: 'slow.delivery', source: 'test', schema,
			binding: {destination: 'slow', target: 'slow'}
		})
		await runtime.events.start()
		await runtime.events.publish('schedule.shutdown', {})
		const publication = runtime.events.publish('slow.delivery', {value: 'slow'})
		await deliveryStarted
		trigger()
		let settled = false
		const shutdown = detachedShutdown.finally(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release()
		await Promise.all([publication, shutdown])
		expect(runtime.events.getStatus().state).toBe('closed')
	})

	it('contains flush awaited from active consumer work while external flush waits for the cutoff', async() => {
		let runtime!: Awaited<ReturnType<typeof createEventsManager>>
		let entered!: () => void
		let release!: () => void
		const handlerEntered = new Promise<void>((resolve) => { entered = resolve })
		const handlerGate = new Promise<void>((resolve) => { release = resolve })
		let internalReturned = false
		runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'combined', inline: true})
		runtime.events.registerConsumer({name: 'reentrant-flush', eventTypes: ['flush.event']}, async() => {
			entered()
			await runtime.events.flush()
			internalReturned = true
			await handlerGate
		})
		await runtime.events.start()
		const publication = runtime.events.publish('flush.event', {})
		await handlerEntered
		await vi.waitFor(() => expect(internalReturned).toBe(true))
		let externalSettled = false
		const externalFlush = runtime.events.flush().finally(() => { externalSettled = true })
		await Promise.resolve()
		expect(externalSettled).toBe(false)
		release()
		await Promise.all([publication, externalFlush])
		await runtime.events.shutdown()
	})

	it('snapshots inbound transport envelopes before reading their fields', async() => {
		let receive!: (event: never) => Promise<void>
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'worker',
			destinations: [{
				name: 'input', kind: 'custom', deliver: async() => undefined,
				startConsumer: async(callback) => { receive = callback as typeof receive; return async() => undefined }
			}]
		})
		await runtime.events.start()
		const getter = vi.fn(() => 'hostile.event')
		const hostile = Object.defineProperty({}, 'type', {enumerable: true, get: getter})
		await expect(receive(hostile as never)).rejects.toMatchObject({
			message: 'EVENTS_ENVELOPE_INVALID', permanent: true, ingress: true
		})
		expect(getter).not.toHaveBeenCalled()
		await runtime.events.shutdown()
	})

	it('keeps inbound clock failures retryable instead of acknowledging the event', async() => {
		let receive!: (event: never) => Promise<void>
		let clockFailed = false
		const runtime = await createEventsManager({
			clock: {now: () => { if (clockFailed) throw new Error('clock unavailable'); return 0 }},
			backend: createMemoryEventsBackend(), role: 'worker',
			destinations: [{
				name: 'input', kind: 'custom', deliver: async() => undefined,
				startConsumer: async(callback) => { receive = callback as typeof receive; return async() => undefined }
			}]
		})
		await runtime.events.start(); clockFailed = true
		const error = await receive({
			id: 'clock-event', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date(0).toISOString(), headers: {}, payload: {}
		} as never).catch((value: unknown) => value)
		expect(error).toMatchObject({message: 'clock unavailable'})
		expect(error).not.toHaveProperty('permanent')
		clockFailed = false; await runtime.events.shutdown()
	})

	it('keeps Kafka and NATS delivery pending until the physical send settles', async() => {
		let finishKafka!: () => void
		let finishNats!: () => void
		let kafkaSettled = false
		let natsSettled = false
		const kafka = createKafkaEventTransport({
			producer: {send: () => new Promise<void>((resolve) => { finishKafka = resolve })},
			allowedTopics: ['events.test'],
			timeoutMs: 1
		})
		const nats = createNatsEventTransport({
			publisher: {publish: () => new Promise<void>((resolve) => { finishNats = resolve })},
			allowedSubjects: ['events.test'],
			timeoutMs: 1
		})
		const event = Object.freeze({
			id: 'event-late', type: 'test.created', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {value: 'ok'}
		})
		const kafkaDelivery = kafka.deliver(
			event,
			{destination: 'kafka', target: 'events.test'},
			new AbortController().signal
		).finally(() => { kafkaSettled = true })
		const natsDelivery = nats.deliver(
			event,
			{destination: 'nats', target: 'events.test'},
			new AbortController().signal
		).finally(() => { natsSettled = true })
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(kafkaSettled).toBe(false)
		expect(natsSettled).toBe(false)
		finishKafka(); finishNats()
		await expect(Promise.all([kafkaDelivery, natsDelivery])).resolves.toEqual([
			expect.objectContaining({status: 'success'}),
			expect.objectContaining({status: 'success'})
		])
	})

	it('uses the runtime clock when deciding whether an inbox lease is busy', async() => {
		const backend = createMemoryEventsBackend()
		const first = await backend.inbox!.claim({consumer: 'consumer', eventId: 'event', owner: 'one', now: 0, expiresAt: 30_000})
		const concurrent = await backend.inbox!.claim({consumer: 'consumer', eventId: 'event', owner: 'two', now: 0, expiresAt: 30_000})
		const expired = await backend.inbox!.claim({consumer: 'consumer', eventId: 'event', owner: 'two', now: 30_001, expiresAt: 60_001})
		expect([first, concurrent, expired]).toEqual(['claimed', 'busy', 'claimed'])
		await expect(backend.inbox!.complete({consumer: 'consumer', eventId: 'event', owner: 'one'})).resolves.toBe(false)
		await expect(backend.inbox!.release({consumer: 'consumer', eventId: 'event', owner: 'one'})).resolves.toBe(false)
		await expect(backend.inbox!.complete({consumer: 'consumer', eventId: 'event', owner: 'two'})).resolves.toBe(true)
	})

	it('keeps memory capacity bounded and batch append atomic', async() => {
		expect(() => createMemoryEventsBackend({maxRecords: Number.NaN})).toThrow('EVENTS_BACKEND_OPTIONS_INVALID')
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend({maxRecords: 1}),
			role: 'publisher'
		})
		await runtime.events.start()
		await expect(runtime.events.publishMany([
			{type: 'one', payload: {}},
			{type: 'two', payload: {}}
		])).rejects.toThrow('EVENTS_BACKEND_CAPACITY')
		expect(await runtime.admin!.listOutbox()).toHaveLength(0)
		await runtime.events.shutdown()
	})

	it('keeps memory batch append atomic when a later record cannot be cloned', async() => {
		const backend = createMemoryEventsBackend()
		const record = (id: string, payload: unknown) => ({
			envelope: {
				id, type: 'test.created', specVersion: '1.0' as const, source: 'test',
				occurredAt: new Date(0).toISOString(), headers: {}, payload
			},
			status: 'queued' as const, attempts: 0, availableAt: 0, createdAt: 0, updatedAt: 0
		})
		await expect(backend.outbox.append([
			record('valid-first', {}),
			record('uncloneable-second', {callback: () => undefined}) as never
		])).rejects.toThrow()
		await expect(backend.admin!.listOutbox()).resolves.toHaveLength(0)
	})

	it('rejects IPv4-mapped IPv6 webhook targets', async() => {
		const destination = createHttpWebhookEventTransport({allowedOrigins: ['https://[::ffff:7f00:1]']})
		const event = Object.freeze({
			id: 'event-1', type: 'test.created', specVersion: '1.0' as const, source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {value: 'ok'}
		})
		await expect(destination.deliver(
			event,
			{destination: 'http', target: 'https://[::ffff:7f00:1]/hook'},
			new AbortController().signal
		)).resolves.toMatchObject({status: 'permanent-failure'})
	})

	it('keeps late consumer startup and flush work under lifecycle ownership', async() => {
		let finishStart!: (stop: () => void) => void
		let finishFlush!: () => void
		let startSettled = false
		let flushSettled = false
		const backend = createMemoryEventsBackend()
		backend.outbox.flush = vi.fn()
			.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFlush = resolve }))
			.mockResolvedValue(undefined)
		const runtime = await createEventsManager({
			clock,
			backend,
			role: 'worker',
			operationTimeoutMs: 100,
			destinations: [{
				name: 'input', kind: 'custom', deliver: async() => undefined,
				startConsumer: () => new Promise((resolve) => { finishStart = resolve })
			}]
		})
		const starting = runtime.events.start().finally(() => { startSettled = true })
		await new Promise((resolve) => setTimeout(resolve, 125))
		expect(startSettled).toBe(false)
		finishStart(() => undefined)
		await starting

		const flushing = runtime.events.flush().finally(() => { flushSettled = true })
		await new Promise((resolve) => setTimeout(resolve, 125))
		expect(flushSettled).toBe(false)
		finishFlush()
		await flushing
		await runtime.events.shutdown()
	})

	it('keeps failed Kafka subscription disposers retryable', async() => {
		const stop = vi.fn()
			.mockRejectedValueOnce(new Error('temporary stop failure'))
			.mockResolvedValue(undefined)
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async() => stop},
			topics: ['events.test'],
			allowedTopics: ['events.test']
		})
		const dispose = await kafka.startConsumer!(async() => undefined)
		await expect(dispose()).rejects.toThrow('temporary stop failure')
		await expect(dispose()).resolves.toBeUndefined()
		expect(stop).toHaveBeenCalledTimes(2)
	})

	it('keeps concurrent Kafka and NATS shutdown callers on the same retryable cleanup flight', async() => {
		const cleanup = () => {
			let release!: () => void
			const gate = new Promise<void>((resolve) => { release = resolve })
			let attempts = 0
			const stop = vi.fn(async() => {
				attempts++
				if (attempts === 1) { await gate; throw new Error('broker cleanup failed') }
			})
			return {release, stop}
		}
		const kafkaCleanup = cleanup()
		const natsCleanup = cleanup()
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async() => kafkaCleanup.stop},
			topics: ['events.test'], allowedTopics: ['events.test'], timeoutMs: 100
		})
		const nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async() => natsCleanup.stop},
			subject: 'events.test', allowedSubjects: ['events.test'], timeoutMs: 100
		})
		for (const entry of [{transport: kafka, cleanup: kafkaCleanup}, {transport: nats, cleanup: natsCleanup}]) {
			await entry.transport.startConsumer!(async() => undefined)
			let secondSettled = false
			const first = entry.transport.shutdown!().catch((error: unknown) => error)
			const second = entry.transport.shutdown!().then(
				() => { secondSettled = true; return undefined },
				(error: unknown) => { secondSettled = true; return error }
			)
			await Promise.resolve()
			expect(secondSettled).toBe(false)
			entry.cleanup.release()
			const failures = await Promise.all([first, second])
			expect(failures).toEqual([
				expect.objectContaining({message: 'broker cleanup failed'}),
				expect.objectContaining({message: 'broker cleanup failed'})
			])
			expect(entry.cleanup.stop).toHaveBeenCalledTimes(1)
			await entry.transport.shutdown!()
			expect(entry.cleanup.stop).toHaveBeenCalledTimes(2)
		}
	})

	it('bounds physically hung broker disposers without losing cleanup ownership', async() => {
		let releaseKafka!: () => void
		let releaseNats!: () => void
		const kafkaGate = new Promise<void>((resolve) => { releaseKafka = resolve })
		const natsGate = new Promise<void>((resolve) => { releaseNats = resolve })
		const stopKafka = vi.fn(async() => kafkaGate)
		const stopNats = vi.fn(async() => natsGate)
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async() => stopKafka},
			topics: ['events.test'], allowedTopics: ['events.test'], timeoutMs: 10
		})
		const nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async() => stopNats},
			subject: 'events.test', allowedSubjects: ['events.test'], timeoutMs: 10
		})
		await Promise.all([
			kafka.startConsumer!(async() => undefined),
			nats.startConsumer!(async() => undefined)
		])
		const failures = await Promise.all([
			kafka.shutdown!().catch((error: unknown) => error),
			nats.shutdown!().catch((error: unknown) => error)
		])
		expect(failures).toEqual([
			expect.objectContaining({message: 'EVENTS_KAFKA_TIMEOUT'}),
			expect.objectContaining({message: 'EVENTS_NATS_TIMEOUT'})
		])
		expect([stopKafka, stopNats].map((stop) => stop.mock.calls.length)).toEqual([1, 1])
		releaseKafka(); releaseNats()
		await Promise.resolve()
		await expect(Promise.all([kafka.shutdown!(), nats.shutdown!()])).resolves.toEqual([undefined, undefined])
		expect([stopKafka, stopNats].map((stop) => stop.mock.calls.length)).toEqual([1, 1])
	})

	it('contains Kafka and NATS shutdown re-entry from subscription disposers', async() => {
		let kafka!: ReturnType<typeof createKafkaEventTransport>
		let nats!: ReturnType<typeof createNatsEventTransport>
		kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async() => async() => kafka.shutdown!()},
			topics: ['events.test'], allowedTopics: ['events.test']
		})
		nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async() => async() => nats.shutdown!()},
			subject: 'events.test', allowedSubjects: ['events.test']
		})
		const stopKafka = await kafka.startConsumer!(async() => undefined)
		const stopNats = await nats.startConsumer!(async() => undefined)
		await expect(Promise.all([stopKafka(), stopNats()])).resolves.toEqual([undefined, undefined])
	})

	it('does not leak broker subscriptions that race or re-enter shutdown during startup', async() => {
		let kafkaStopAttempts = 0
		const stopKafka = vi.fn(async() => {
			kafkaStopAttempts++
			if (kafkaStopAttempts === 1) throw new Error('late cleanup failed')
		})
		let kafka!: ReturnType<typeof createKafkaEventTransport>
		kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async() => { await kafka.shutdown!(); return stopKafka }},
			topics: ['events.test'], allowedTopics: ['events.test'], timeoutMs: 100
		})
		await expect(kafka.startConsumer!(async() => undefined)).rejects.toThrow('late cleanup failed')
		expect(stopKafka).toHaveBeenCalledTimes(1)
		await kafka.shutdown!()
		expect(stopKafka).toHaveBeenCalledTimes(2)

		let finishNats!: (stop: () => Promise<void>) => void
		const stopNats = vi.fn(async() => undefined)
		const nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: () => new Promise((resolve) => { finishNats = resolve })},
			subject: 'events.test', allowedSubjects: ['events.test'], timeoutMs: 100
		})
		const starting = nats.startConsumer!(async() => undefined)
		const stopping = nats.shutdown!()
		finishNats(stopNats)
		await expect(Promise.all([starting, stopping])).resolves.toEqual([expect.any(Function), undefined])
		expect(stopNats).toHaveBeenCalledTimes(1)
	})

	it('contains broker shutdown awaited from an inbound handler whose disposer drains that handler', async() => {
		let kafkaHandler!: (message: {topic: string; value: string}) => Promise<void>
		let natsHandler!: (message: {subject: string; data: string}) => Promise<void>
		let finishKafkaHandler!: () => void
		let finishNatsHandler!: () => void
		const kafkaHandlerDone = new Promise<void>((resolve) => { finishKafkaHandler = resolve })
		const natsHandlerDone = new Promise<void>((resolve) => { finishNatsHandler = resolve })
		let kafka!: ReturnType<typeof createKafkaEventTransport>
		let nats!: ReturnType<typeof createNatsEventTransport>
		kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async(_topics, handler) => {
				kafkaHandler = handler
				return async() => kafkaHandlerDone
			}},
			topics: ['events.test'], allowedTopics: ['events.test']
		})
		nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async(_subject, handler) => {
				natsHandler = handler as typeof natsHandler
				return async() => natsHandlerDone
			}},
			subject: 'events.test', allowedSubjects: ['events.test']
		})
		await Promise.all([
			kafka.startConsumer!(async() => { await kafka.shutdown!(); finishKafkaHandler() }),
			nats.startConsumer!(async() => { await nats.shutdown!(); finishNatsHandler() })
		])
		const envelope = JSON.stringify({
			id: 'inbound-shutdown', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		})
		await expect(Promise.all([
			kafkaHandler({topic: 'events.test', value: envelope}),
			natsHandler({subject: 'events.test', data: envelope})
		])).resolves.toEqual([undefined, undefined])
		await Promise.all([kafka.shutdown!(), nats.shutdown!()])
	})

	it('waits for active broker callbacks even when unsubscribe returns immediately', async() => {
		let kafkaHandler!: (message: {topic: string; value: string}) => Promise<void>
		let natsHandler!: (message: {subject: string; data: string}) => Promise<void>
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async(_topics, handler) => { kafkaHandler = handler; return async() => undefined }},
			topics: ['events.test'], allowedTopics: ['events.test']
		})
		const nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async(_subject, handler) => {
				natsHandler = handler as typeof natsHandler
				return async() => undefined
			}},
			subject: 'events.test', allowedSubjects: ['events.test']
		})
		await Promise.all([
			kafka.startConsumer!(async() => gate),
			nats.startConsumer!(async() => gate)
		])
		const envelope = JSON.stringify({
			id: 'inbound-drain', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		})
		const callbacks = Promise.all([
			kafkaHandler({topic: 'events.test', value: envelope}),
			natsHandler({subject: 'events.test', data: envelope})
		])
		let settled = false
		const shutdowns = Promise.all([kafka.shutdown!(), nats.shutdown!()]).finally(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		release()
		await expect(Promise.all([callbacks, shutdowns])).resolves.toEqual([
			[undefined, undefined], [undefined, undefined]
		])
	})

	it('bounds broker callback admission before decoding unbounded concurrent messages', async() => {
		let kafkaHandler!: (message: {topic: string; value: string}) => Promise<void>
		let natsHandler!: (message: {subject: string; data: string}) => Promise<void>
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const kafkaEvent = vi.fn(async() => gate)
		const natsEvent = vi.fn(async() => gate)
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async(_topics, handler) => { kafkaHandler = handler; return async() => undefined }},
			topics: ['events.test'], allowedTopics: ['events.test']
		})
		const nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async(_subject, handler) => {
				natsHandler = handler as typeof natsHandler
				return async() => undefined
			}},
			subject: 'events.test', allowedSubjects: ['events.test']
		})
		await Promise.all([kafka.startConsumer!(kafkaEvent), nats.startConsumer!(natsEvent)])
		const envelope = JSON.stringify({
			id: 'bounded-ingress', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		})
		const kafkaWork = Array.from({length: 33}, () => kafkaHandler({topic: 'events.test', value: envelope}))
		const natsWork = Array.from({length: 33}, () => natsHandler({subject: 'events.test', data: envelope}))
		await expect(kafkaWork[32]).rejects.toThrow('EVENTS_INGRESS_BUSY')
		await expect(natsWork[32]).rejects.toThrow('EVENTS_INGRESS_BUSY')
		expect([kafkaEvent.mock.calls.length, natsEvent.mock.calls.length]).toEqual([32, 32])
		release()
		await Promise.all([...kafkaWork.slice(0, 32), ...natsWork.slice(0, 32)])
		await Promise.all([kafka.shutdown!(), nats.shutdown!()])
	})

	it('rejects final broker callbacks raised while unsubscribe is running', async() => {
		let kafkaHandler!: (message: {topic: string; value: string}) => Promise<void>
		let natsHandler!: (message: {subject: string; data: string}) => Promise<void>
		const kafkaEvent = vi.fn(async() => undefined)
		const natsEvent = vi.fn(async() => undefined)
		const envelope = JSON.stringify({
			id: 'unsubscribe-race', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		})
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async(_topics, handler) => {
				kafkaHandler = handler
				return () => { void kafkaHandler({topic: 'events.test', value: envelope}) }
			}},
			topics: ['events.test'], allowedTopics: ['events.test']
		})
		const nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async(_subject, handler) => {
				natsHandler = handler as typeof natsHandler
				return () => { void natsHandler({subject: 'events.test', data: envelope}) }
			}},
			subject: 'events.test', allowedSubjects: ['events.test']
		})
		await Promise.all([
			kafka.startConsumer!(kafkaEvent),
			nats.startConsumer!(natsEvent)
		])
		await expect(Promise.all([kafka.shutdown!(), nats.shutdown!()])).resolves.toEqual([undefined, undefined])
		expect(kafkaEvent).not.toHaveBeenCalled()
		expect(natsEvent).not.toHaveBeenCalled()
	})

	it('rolls back partial lifecycle registration and retries failed disposal', async() => {
		const rollback = vi.fn()
		await expect(createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'publisher',
			lifecycle: {
				registerFlushHook: () => rollback,
				registerShutdownHook: () => { throw new Error('registration failed') }
			} as never
		})).rejects.toThrow('registration failed')
		expect(rollback).toHaveBeenCalledTimes(1)

		const firstDisposer = vi.fn()
			.mockImplementationOnce(() => { throw new Error('disposal failed') })
			.mockImplementation(() => undefined)
		const secondDisposer = vi.fn(() => undefined)
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'publisher',
			lifecycle: {
				registerFlushHook: () => firstDisposer,
				registerShutdownHook: () => secondDisposer
			} as never
		})
		await runtime.events.start()
		await expect(runtime.events.shutdown()).rejects.toThrow('disposal failed')
		await expect(runtime.events.shutdown()).resolves.toBeUndefined()
		expect(firstDisposer).toHaveBeenCalledTimes(2)
		expect(secondDisposer).toHaveBeenCalledTimes(1)
	})

	it('contains rejected promises returned by synchronous lifecycle capabilities', async() => {
		await expect(createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'publisher',
			lifecycle: {
				registerFlushHook: () => Promise.reject(new Error('invalid async registration')),
				registerShutdownHook: vi.fn()
			} as never
		})).rejects.toThrow('EVENTS_EXTENSION_INVALID')

		await expect(createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'publisher',
			lifecycle: {
				registerFlushHook: () => () => Promise.reject(new Error('invalid async disposer')),
				registerShutdownHook: () => { throw new Error('registration failed') }
			} as never
		})).rejects.toThrow('registration failed')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('adopts async lifecycle disposer completion during retryable shutdown', async() => {
		const dispose = vi.fn()
			.mockRejectedValueOnce(new Error('async disposal failed'))
			.mockResolvedValue(undefined)
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'publisher',
			lifecycle: {
				registerFlushHook: () => dispose,
				registerShutdownHook: () => vi.fn()
			} as never
		})
		await runtime.events.start()
		await expect(runtime.events.shutdown()).rejects.toThrow('async disposal failed')
		await expect(runtime.events.shutdown()).resolves.toBeUndefined()
		expect(dispose).toHaveBeenCalledTimes(2)
	})

	it('fails construction cleanly when lifecycle registration reenters shutdown', async() => {
		const backend = createMemoryEventsBackend()
		const shutdown = vi.fn(async() => undefined)
		const dispose = vi.fn()
		await expect(createEventsManager({
			clock,
			backend: {...backend, outbox: {...backend.outbox, shutdown}},
			role: 'publisher',
			lifecycle: {
				registerFlushHook: () => dispose,
				registerShutdownHook: (_phase: unknown, hook: () => Promise<void>) => { void hook(); return dispose }
			} as never
		})).rejects.toThrow('EVENTS_EXTENSION_INVALID')
		expect(shutdown).toHaveBeenCalledTimes(1)
		expect(dispose).toHaveBeenCalledTimes(2)
	})

	it('dead-letters semantically invalid custom backend records without spreading them', async() => {
		const backend = createMemoryEventsBackend()
		const deadLetter = vi.fn(async() => true)
		const record = {
			envelope: {
				id: 'hostile-record', type: 'test.created', specVersion: '1.0', source: 'test',
				occurredAt: new Date().toISOString(), headers: {}, payload: {}
			},
			traceContext: 'x'.repeat(10_000),
			status: 'dispatching', attempts: 1, availableAt: 0, createdAt: 0, updatedAt: 0,
			lease: {owner: 'backend', expiresAt: 30_000, generation: 1}
		}
		const runtime = await createEventsManager({
			clock: {now: () => 0},
			backend: {...backend, outbox: {
				...backend.outbox,
				claimDue: async() => [record] as never,
				deadLetter
			}},
			role: 'worker'
		})
		await runtime.events.start()
		expect(deadLetter).toHaveBeenCalledWith(
			'hostile-record',
			expect.stringContaining('events-'),
			1,
			'EVENTS_ENVELOPE_INVALID'
		)
		await runtime.events.shutdown()
	})

	it('detects PostgreSQL event idempotency conflicts instead of silently dropping them', async() => {
		const backend = createPostgresEventsBackend({client: {query: vi.fn(async() => ({rows: [], rowCount: 0}))}})
		const timestamp = Date.now()
		await expect(backend.outbox.append([{
			envelope: {
				id: 'same-id', type: 'test.created', specVersion: '1.0', source: 'test',
				occurredAt: new Date(timestamp).toISOString(), headers: {}, payload: {}
			},
			status: 'queued', attempts: 0, availableAt: timestamp, createdAt: timestamp, updatedAt: timestamp
		}])).rejects.toThrow('EVENTS_IDEMPOTENCY_CONFLICT')
	})

	it('detects memory event idempotency conflicts in delivery metadata', async() => {
		const backend = createMemoryEventsBackend()
		const timestamp = Date.now()
		const record = {
			envelope: {
				id: 'same-memory-id', type: 'test.created', specVersion: '1.0' as const, source: 'test',
				occurredAt: new Date(timestamp).toISOString(), headers: {}, payload: {}
			},
			binding: {destination: 'custom', target: 'first'},
			status: 'queued' as const, attempts: 0, availableAt: timestamp, createdAt: timestamp, updatedAt: timestamp
		}
		await backend.outbox.append([record])
		await expect(backend.outbox.append([{...record, binding: {...record.binding, target: 'second'}}]))
			.rejects.toThrow('EVENTS_IDEMPOTENCY_CONFLICT')
	})

	it('appends PostgreSQL event batches in one atomic statement', async() => {
		const query = vi.fn(async() => ({rows: [{event_id: 'one'}, {event_id: 'two'}], rowCount: 2}))
		const backend = createPostgresEventsBackend({client: {query}})
		const record = (id: string) => ({
			envelope: {
				id, type: 'test.created', specVersion: '1.0' as const, source: 'test',
				occurredAt: new Date(0).toISOString(), headers: {}, payload: {}
			},
			payloadValidated: true as const,
			status: 'queued' as const, attempts: 0, availableAt: 0, createdAt: 0, updatedAt: 0
		})
		await backend.outbox.append([record('one'), record('two')])
		expect(query).toHaveBeenCalledTimes(1)
		expect(query.mock.calls[0]![0]).toContain("($5,$6::jsonb,'queued'")
		expect(JSON.parse(query.mock.calls[0]![1]![1] as string).__events).toMatchObject({payloadValidated: true})
		expect(query.mock.calls[0]![1]).toHaveLength(8)
	})

	it('routes revoked proxy failures through retry instead of escaping the failure handler', async() => {
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true
		})
		runtime.events.registerDefinition({type: 'proxy.failure', source: 'test', schema})
		runtime.events.registerConsumer({name: 'proxy-consumer', eventTypes: ['proxy.failure']}, async() => {
			const {proxy, revoke} = Proxy.revocable({}, {})
			revoke()
			throw proxy
		})
		await runtime.events.start()
		await expect(runtime.events.publish('proxy.failure', {value: 'retry'})).resolves.toMatchObject({type: 'proxy.failure'})
		expect(runtime.events.getStatus().retriedTotal).toBe(1)
		await runtime.events.shutdown()
	})

	it('rejects non-global webhook address ranges', async() => {
		for (const address of [
			'192.0.0.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
			'[3fff::1]', '[fec0::1]'
		]) {
			const origin = `https://${address}`
			const destination = createHttpWebhookEventTransport({allowedOrigins: [origin]})
			await expect(destination.deliver({
				id: 'event-1', type: 'test.created', specVersion: '1.0', source: 'test',
				occurredAt: new Date().toISOString(), headers: {}, payload: {}
			}, {destination: 'http', target: `${origin}/hook`}, new AbortController().signal))
				.resolves.toMatchObject({status: 'permanent-failure'})
		}
	})

	it('keeps tracing fail-open per operation without permanently disabling correlation', async() => {
		const inSpan = vi.fn(() => new Promise<never>(() => undefined))
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		wireEventsObservability(runtime.events, {tracer: {inSpan} as never})
		await runtime.events.start()
		await expect(runtime.events.publish('trace.hang', {})).resolves.toMatchObject({type: 'trace.hang'})
		await expect(runtime.events.publish('trace.after-hang', {})).resolves.toMatchObject({type: 'trace.after-hang'})
		expect(inSpan).toHaveBeenCalledTimes(2)
		await runtime.events.shutdown()
	})

	it('drops invalid injected trace context without poisoning event delivery', async() => {
		const consumer = vi.fn()
		let accessorInvoked = false
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true
		})
		runtime.events.registerDefinition({type: 'trace.invalid', source: 'test', schema})
		runtime.events.registerConsumer({name: 'trace-invalid-consumer', eventTypes: ['trace.invalid']}, consumer)
		wireEventsObservability(runtime.events, {tracer: {
			injectHeaders(carrier: Record<string, unknown>) {
				Object.defineProperty(carrier, 'traceparent', {enumerable: true, get() {
					accessorInvoked = true
					throw new Error('hostile trace accessor')
				}})
				carrier.baggage = 'x'.repeat(10_000)
			}
		} as never})
		await runtime.events.start()
		await expect(runtime.events.publish('trace.invalid', {value: 'ok'})).resolves.toMatchObject({type: 'trace.invalid'})
		expect(consumer).toHaveBeenCalledTimes(1)
		expect(accessorInvoked).toBe(false)
		await runtime.events.shutdown()
	})

	it('bounds privileged admin mutations and backend result sets', async() => {
		const memoryRuntime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		await expect(memoryRuntime.admin!.replay({limit: 1_001})).rejects.toThrow('EVENTS_ADMIN_INPUT_INVALID')
		await expect(memoryRuntime.admin!.listDeadLetters(0)).rejects.toThrow('EVENTS_ADMIN_INPUT_INVALID')
		await memoryRuntime.events.shutdown()

		const backend = createMemoryEventsBackend()
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, admin: {
				...backend.admin!,
				replay: async() => 2,
				listOutbox: async() => [{}, {}] as never
			}},
			role: 'publisher'
		})
		await expect(runtime.admin!.replay({limit: 1})).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		await expect(runtime.admin!.listOutbox({limit: 1})).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		await runtime.events.shutdown()
	})

	it('contains rejected fields across every invalid admin result row', async() => {
		const backend = createMemoryEventsBackend()
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, admin: {
				...backend.admin!,
				listOutbox: async() => [{
					status: Promise.reject(new Error('first admin status rejection'))
				}, {
					status: Promise.reject(new Error('second admin status rejection')),
					failureCode: Promise.reject(new Error('second admin code rejection'))
				}] as never
			}},
			role: 'publisher'
		})
		await expect(runtime.admin!.listOutbox()).rejects.toThrow('EVENTS_BACKEND_RESULT_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await runtime.events.shutdown()
	})

	it('projects custom admin rows onto the safe summary contract', async() => {
		const backend = createMemoryEventsBackend()
		const timestamp = new Date().toISOString()
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, admin: {
				...backend.admin!,
				listOutbox: async() => [{
					eventId: 'event', type: 'test.created', status: 'queued', attempts: 0,
					createdAt: timestamp, updatedAt: timestamp, payload: {secret: 'hidden'}, headers: {authorization: 'hidden'}
				}] as never
			}},
			role: 'publisher'
		})
		const [row] = await runtime.admin!.listOutbox()
		expect(row).toEqual({
			eventId: 'event', type: 'test.created', status: 'queued', attempts: 0,
			createdAt: timestamp, updatedAt: timestamp
		})
		await runtime.events.shutdown()
	})

	it('releases failed inbox claims so retry attempts invoke the consumer again', async() => {
		let now = 0
		const backend = createMemoryEventsBackend()
		const inboxOwners: string[] = []
		const handler = vi.fn()
			.mockRejectedValueOnce(new Error('temporary consumer failure'))
			.mockResolvedValue(undefined)
		const runtime = await createEventsManager({
			clock: {now: () => now},
			backend: {...backend, inbox: {...backend.inbox!, claim: async(input) => {
				inboxOwners.push(input.owner)
				return backend.inbox!.claim(input)
			}}},
			role: 'combined',
			inline: true,
			maxAttempts: 2
		})
		runtime.events.registerDefinition({type: 'consumer.retry', source: 'test', schema})
		runtime.events.registerConsumer({name: 'retrying-consumer', eventTypes: ['consumer.retry']}, handler)
		await runtime.events.start()
		await runtime.events.publish('consumer.retry', {value: 'first'})
		expect(runtime.events.getStatus()).toMatchObject({retriedTotal: 1, deadLetteredTotal: 0})
		now = 1_000
		await runtime.events.publish('consumer.retry', {value: 'trigger'})
		expect(handler).toHaveBeenCalledTimes(3)
		expect(new Set(inboxOwners).size).toBe(inboxOwners.length)
		expect(runtime.events.getStatus().deadLetteredTotal).toBe(0)
		await runtime.events.shutdown()
	})

	it('waits for inbox contention without consuming the delivery attempt budget', async() => {
		vi.useFakeTimers()
		try {
			const backend = createMemoryEventsBackend()
			const claim = vi.fn()
				.mockResolvedValueOnce('busy' as const)
				.mockImplementation((input) => backend.inbox!.claim(input))
			const handler = vi.fn()
			const runtime = await createEventsManager({
				clock: {now: () => Date.now()},
				backend: {...backend, inbox: {...backend.inbox!, claim}},
				role: 'combined', inline: true, maxAttempts: 1
			})
			runtime.events.registerDefinition({type: 'consumer.busy', source: 'test', schema})
			runtime.events.registerConsumer({name: 'busy-consumer', eventTypes: ['consumer.busy']}, handler)
			await runtime.events.start()
			const publication = runtime.events.publish('consumer.busy', {value: 'event'})
			await vi.advanceTimersByTimeAsync(250)
			await publication
			expect(claim).toHaveBeenCalledTimes(2)
			expect(handler).toHaveBeenCalledTimes(1)
			expect(runtime.events.getStatus()).toMatchObject({retriedTotal: 0, deadLetteredTotal: 0})
			await runtime.events.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('aborts an inbox contention wait during bounded shutdown', async() => {
		const backend = createMemoryEventsBackend()
		const claim = vi.fn(async() => 'busy' as const)
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, inbox: {...backend.inbox!, claim}},
			role: 'combined', inline: true, operationTimeoutMs: 100, shutdownTimeoutMs: 100
		})
		runtime.events.registerDefinition({type: 'consumer.shutdown-busy', source: 'test', schema})
		runtime.events.registerConsumer({name: 'shutdown-busy-consumer', eventTypes: ['consumer.shutdown-busy']}, vi.fn())
		await runtime.events.start()
		const publication = runtime.events.publish('consumer.shutdown-busy', {value: 'event'})
		await vi.waitFor(() => expect(claim).toHaveBeenCalled())
		await expect(Promise.all([publication, runtime.events.shutdown()])).resolves.toHaveLength(2)
		expect(runtime.events.getStatus().state).toBe('closed')
	})

	it('waits for every consumer before releasing the outbox lease after a failure', async() => {
		let finishSlow!: () => void
		let settled = false
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true
		})
		runtime.events.registerDefinition({type: 'consumer.parallel', source: 'test', schema})
		runtime.events.registerConsumer({name: 'failing', eventTypes: ['consumer.parallel']}, async() => {
			throw new Error('consumer failure')
		})
		runtime.events.registerConsumer({name: 'slow', eventTypes: ['consumer.parallel']}, () => new Promise<void>((resolve) => {
			finishSlow = resolve
		}))
		await runtime.events.start()
		const publication = runtime.events.publish('consumer.parallel', {value: 'test'}).finally(() => { settled = true })
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(settled).toBe(false)
		expect(runtime.events.getStatus().retriedTotal).toBe(0)
		finishSlow()
		await publication
		expect(runtime.events.getStatus().retriedTotal).toBe(1)
		await runtime.events.shutdown()
	})

	it('bounds shutdown while consumer startup remains physically hung', async() => {
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'worker',
			operationTimeoutMs: 100,
			shutdownTimeoutMs: 100,
			destinations: [{
				name: 'hung', kind: 'custom', deliver: async() => undefined,
				startConsumer: () => new Promise<never>(() => undefined)
			}]
		})
		void runtime.events.start()
		await new Promise((resolve) => setTimeout(resolve, 10))
		await expect(runtime.events.shutdown()).rejects.toThrow('EVENTS_SHUTDOWN_TIMEOUT')
		expect(runtime.events.getStatus()).toMatchObject({state: 'draining', backendState: 'unhealthy'})
	})

	it('stops renewing outbox and inbox leases after shutdown aborts a hung consumer', async() => {
		vi.useFakeTimers()
		try {
			const backend = createMemoryEventsBackend()
			const renewOutbox = vi.spyOn(backend.outbox, 'renew')
			const renewInbox = vi.spyOn(backend.inbox!, 'renew')
			let started!: () => void
			let finish!: () => void
			const handlerStarted = new Promise<void>((resolve) => { started = resolve })
			const handlerFinished = new Promise<void>((resolve) => { finish = resolve })
			const runtime = await createEventsManager({
				clock,
				backend,
				role: 'combined',
				inline: true,
				shutdownTimeoutMs: 100
			})
			runtime.events.registerConsumer({name: 'hung-consumer', eventTypes: ['hung.event']}, async() => {
				started()
				await handlerFinished
			})
			await runtime.events.start()
			const publication = runtime.events.publish('hung.event', {})
			await handlerStarted
			await vi.advanceTimersByTimeAsync(10_000)
			expect(renewOutbox).toHaveBeenCalledTimes(1)
			expect(renewInbox).toHaveBeenCalledTimes(1)
			const shutdown = runtime.events.shutdown().catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(101)
			await expect(shutdown).resolves.toMatchObject({message: 'EVENTS_SHUTDOWN_TIMEOUT'})
			await vi.advanceTimersByTimeAsync(30_000)
			expect(renewOutbox).toHaveBeenCalledTimes(1)
			expect(renewInbox).toHaveBeenCalledTimes(1)
			finish()
			await publication
			await runtime.events.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('purges inbox deduplication state together with expired outbox records', async() => {
		const backend = createMemoryEventsBackend()
		const record = {
			envelope: {
				id: 'expiring-event', type: 'test.expiring', specVersion: '1.0' as const, source: 'test',
				occurredAt: new Date(0).toISOString(), expiresAt: new Date(10).toISOString(), headers: {}, payload: {}
			},
			status: 'queued' as const, attempts: 0, availableAt: 0, expiresAt: 10, createdAt: 0, updatedAt: 0
		}
		await backend.outbox.append([record])
		await backend.inbox!.claim({consumer: 'consumer', eventId: 'expiring-event', owner: 'one', now: 0, expiresAt: 30_000})
		await backend.inbox!.complete({consumer: 'consumer', eventId: 'expiring-event', owner: 'one'})
		await expect(backend.outbox.purgeExpired(11, 1)).resolves.toBe(1)
		await expect(backend.inbox!.claim({
			consumer: 'consumer', eventId: 'expiring-event', owner: 'two', now: 11, expiresAt: 30_011
		})).resolves.toBe('claimed')

		const query = vi.fn(async() => ({rows: [{count: '2'}], rowCount: 1}))
		const postgres = createPostgresEventsBackend({client: {query}})
		await expect(postgres.outbox.purgeExpired(11, 2)).resolves.toBe(2)
		expect(query.mock.calls[0]![0]).toContain('DELETE FROM events_inbox')
		query.mockResolvedValueOnce({rows: [], rowCount: 0})
		await postgres.outbox.claimDue({now: 11, limit: 1, owner: 'worker', leaseMs: 30_000})
		expect(query.mock.calls[1]![0]).toContain("envelope_json#>>'{__events,expiresAt}'")
		expect(query.mock.calls[1]![0]).toContain('processing_started_at IS NULL OR processing_started_at<')
		expect(query.mock.calls[1]![0]).toContain('CASE WHEN o.attempts>=1000000 THEN 1000000 ELSE o.attempts+1 END')
		expect(query.mock.calls[1]![0]).not.toContain("(envelope_json->>'expiresAt')::timestamptz")
	})

	it('does not purge expired events while their dispatch lease is still active', async() => {
		const backend = createMemoryEventsBackend()
		await backend.outbox.append([{
			envelope: {
				id: 'active-expiring-event', type: 'test.expiring', specVersion: '1.0', source: 'test',
				occurredAt: new Date(0).toISOString(), expiresAt: new Date(10).toISOString(), headers: {}, payload: {}
			},
			status: 'queued', attempts: 0, availableAt: 0, expiresAt: 10, createdAt: 0, updatedAt: 0
		}])
		const [claimed] = await backend.outbox.claimDue({now: 5, limit: 1, owner: 'worker', leaseMs: 100})
		expect(claimed?.lease?.expiresAt).toBe(105)
		await expect(backend.outbox.purgeExpired(11, 1)).resolves.toBe(0)
		await expect(backend.outbox.complete('active-expiring-event', 'worker', claimed!.lease!.generation)).resolves.toBe(true)

		const query = vi.fn(async() => ({rows: [{count: '0'}], rowCount: 0}))
		const postgres = createPostgresEventsBackend({client: {query}})
		await expect(postgres.outbox.purgeExpired(11, 1)).resolves.toBe(0)
		expect(query.mock.calls[0]![0]).toContain("status<>'dispatching' OR processing_started_at IS NULL OR processing_started_at<=to_timestamp($1/1000.0)")
		expect(query.mock.calls[0]![0]).toContain('FOR UPDATE SKIP LOCKED')
	})

	it('purges expired memory records whose dispatch lease is missing', async() => {
		const backend = createMemoryEventsBackend()
		await backend.outbox.append([{
			envelope: {
				id: 'missing-memory-lease', type: 'test.expiring', specVersion: '1.0', source: 'test',
				occurredAt: new Date(0).toISOString(), expiresAt: new Date(10).toISOString(), headers: {}, payload: {}
			},
			status: 'dispatching', attempts: 1, availableAt: 0, expiresAt: 10, createdAt: 0, updatedAt: 0
		}])
		await expect(backend.outbox.purgeExpired(11, 1)).resolves.toBe(1)
		await expect(backend.admin!.listOutbox()).resolves.toEqual([])
	})

	it('treats pre-epoch PostgreSQL expirations as expired instead of immortal', async() => {
		const query = vi.fn()
			.mockResolvedValueOnce({rows: [], rowCount: 0})
			.mockResolvedValueOnce({rows: [{count: '1'}], rowCount: 1})
		const postgres = createPostgresEventsBackend({client: {query}})
		await expect(postgres.outbox.claimDue({now: 0, limit: 1, owner: 'worker', leaseMs: 30_000})).resolves.toEqual([])
		expect(query.mock.calls[0]![0]).toContain("~ '^-?[0-9]{1,16}$'")
		await expect(postgres.outbox.purgeExpired(0, 1)).resolves.toBe(1)
		expect(query.mock.calls[1]![0]).toContain("~ '^-?[0-9]{1,16}$'")
	})

	it('uses one PostgreSQL timestamp meaning for claim, renewal, and decoded lease expiry', async() => {
		const query = vi.fn(async() => ({rows: [{
			event_id: 'lease-event',
			envelope_json: {
				id: 'lease-event', type: 'lease.event', specVersion: '1.0', source: 'test',
				occurredAt: new Date(1_001).toISOString(), headers: {}, payload: {},
				__events: {payloadValidated: true}
			},
			status: 'dispatching', attempts: 1, last_error: null, next_attempt_at: new Date(1_001),
			processing_started_at: new Date(31_001), processing_by: 'worker',
			created_at: new Date(1_001), updated_at: new Date(1_001)
		}], rowCount: 1}))
		const postgres = createPostgresEventsBackend({client: {query}})
		const records = await postgres.outbox.claimDue({now: 1_001, limit: 1, owner: 'worker', leaseMs: 30_000})
		expect(records[0]?.lease?.expiresAt).toBe(31_001)
		expect(records[0]?.payloadValidated).toBe(true)
		expect(query.mock.calls[0]![0]).toContain('processing_started_at<to_timestamp($1/1000.0)')
		expect(query.mock.calls[0]![0]).toContain('processing_started_at=to_timestamp(($1+$4)/1000.0)')
	})

	it('converts malformed claimed PostgreSQL rows into fenceable poison records', async() => {
		const query = vi.fn(async() => ({rows: [{
			event_id: 'poison-event', envelope_json: [], status: 'dispatching', attempts: 4, last_error: null,
			next_attempt_at: new Date(0), processing_started_at: new Date(30_000), processing_by: 'worker',
			created_at: new Date(0), updated_at: new Date(0)
		}], rowCount: 1}))
		const postgres = createPostgresEventsBackend({client: {query}})
		await expect(postgres.outbox.claimDue({now: 0, limit: 1, owner: 'worker', leaseMs: 30_000})).resolves.toEqual([
			expect.objectContaining({
				envelope: {id: 'poison-event'}, status: 'dispatching', attempts: 4,
				lease: {owner: 'worker', expiresAt: 0, generation: 4}
			})
		])
	})

	it('reclaims malformed PostgreSQL inbox leases without unsafe casts', async() => {
		const query = vi.fn()
			.mockResolvedValueOnce({rows: [{record_json: {owner: 'worker', expiresAt: 30_000, complete: false}}], rowCount: 1})
		const postgres = createPostgresEventsBackend({client: {query}})
		await expect(postgres.inbox!.claim({
			consumer: 'consumer', eventId: 'event', owner: 'worker', now: 0, expiresAt: 30_000
		})).resolves.toBe('claimed')
		expect(query.mock.calls[0]![0]).toContain("IS DISTINCT FROM 'true'")
		expect(query.mock.calls[0]![0]).toContain('CASE WHEN COALESCE')
		expect(query.mock.calls[0]![0]).toContain("~ '^-?[0-9]{1,16}$'")
		expect(query.mock.calls[0]![0]).not.toContain('::boolean')
	})

	it('keeps memory inbox tuple keys collision-free', async() => {
		const inbox = createMemoryEventsBackend().inbox!
		await expect(inbox.claim({consumer: 'a\0b', eventId: 'c', owner: 'one', now: 0, expiresAt: 10})).resolves.toBe('claimed')
		await inbox.complete({consumer: 'a\0b', eventId: 'c', owner: 'one'})
		await expect(inbox.claim({consumer: 'a', eventId: 'b\0c', owner: 'two', now: 0, expiresAt: 10})).resolves.toBe('claimed')
	})

	it('rejects non-array broker allowlists before iterating them', () => {
		const iterator = vi.fn(function*() { while (true) yield 'events.test' })
		const hostile = {[Symbol.iterator]: iterator}
		expect(() => createKafkaEventTransport({
			producer: {send: async() => undefined}, allowedTopics: hostile as never
		})).toThrow('EVENTS_KAFKA_TOPICS_INVALID')
		expect(() => createNatsEventTransport({
			publisher: {publish: async() => undefined}, allowedSubjects: hostile as never
		})).toThrow('EVENTS_NATS_SUBJECTS_INVALID')
		expect(iterator).not.toHaveBeenCalled()
	})

	it('rejects accessor-backed broker configuration and client methods without invoking them', () => {
		const configurationGetter = vi.fn(() => ['events.test'])
		const kafkaOptions = Object.defineProperty({producer: {send: async() => undefined}}, 'allowedTopics', {
			enumerable: true, get: configurationGetter
		})
		expect(() => createKafkaEventTransport(kafkaOptions as never)).toThrow('EVENTS_KAFKA_TOPICS_INVALID')

		const methodGetter = vi.fn(() => async() => undefined)
		const producer = Object.defineProperty({}, 'send', {enumerable: true, get: methodGetter})
		expect(() => createKafkaEventTransport({producer: producer as never, allowedTopics: ['events.test']}))
			.toThrow('EVENTS_KAFKA_PRODUCER_INVALID')
		const subscriber = Object.defineProperty({}, 'subscribe', {enumerable: true, get: methodGetter})
		expect(() => createNatsEventTransport({
			publisher: {publish: async() => undefined}, subscriber: subscriber as never,
			allowedSubjects: ['events.test']
		})).toThrow('EVENTS_NATS_SUBSCRIBER_INVALID')
		expect(configurationGetter).not.toHaveBeenCalled()
		expect(methodGetter).not.toHaveBeenCalled()
	})

	it('rejects non-finite HTTP limits and reserved signing headers', () => {
		expect(() => createHttpWebhookEventTransport({
			allowedOrigins: ['https://example.com'], timeoutMs: Number.NaN
		})).toThrow('EVENTS_HTTP_LIMITS_INVALID')
		expect(() => createHttpWebhookEventTransport({
			allowedOrigins: ['https://example.com'],
			signing: {secret: 'x'.repeat(16), headerName: 'x-event-id'}
		})).toThrow('EVENTS_HTTP_SIGNING_INVALID')
	})

	it('rejects accessor-backed HTTP configuration without invoking it', () => {
		const originGetter = vi.fn(() => ['https://example.com'])
		const options = Object.defineProperty({}, 'allowedOrigins', {enumerable: true, get: originGetter})
		expect(() => createHttpWebhookEventTransport(options as never)).toThrow('EVENTS_HTTP_ORIGINS_INVALID')

		const secretGetter = vi.fn(() => 'x'.repeat(16))
		const signing = Object.defineProperty({}, 'secret', {enumerable: true, get: secretGetter})
		expect(() => createHttpWebhookEventTransport({
			allowedOrigins: ['https://example.com'], signing: signing as never
		})).toThrow('EVENTS_HTTP_SIGNING_INVALID')
		expect(originGetter).not.toHaveBeenCalled()
		expect(secretGetter).not.toHaveBeenCalled()
	})

	it('does not subscribe Kafka consumers without explicit topics', async() => {
		const subscribe = vi.fn(async() => async() => undefined)
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined}, consumer: {subscribe}, allowedTopics: ['events.test']
		})
		await kafka.startConsumer!(async() => undefined)
		expect(subscribe).not.toHaveBeenCalled()
	})

	it('snapshots broker subscription policy when transports are created', async() => {
		const kafkaSubscribe = vi.fn(async() => async() => undefined)
		const natsSubscribe = vi.fn(async() => async() => undefined)
		const kafkaOptions = {
			producer: {send: async() => undefined}, consumer: {subscribe: kafkaSubscribe},
			topics: ['events.original'], allowedTopics: ['events.original', 'events.mutated']
		}
		const natsOptions = {
			publisher: {publish: async() => undefined}, subscriber: {subscribe: natsSubscribe},
			subject: 'events.original', allowedSubjects: ['events.original', 'events.mutated']
		}
		const kafka = createKafkaEventTransport(kafkaOptions)
		const nats = createNatsEventTransport(natsOptions)
		kafkaOptions.topics = ['events.mutated']
		natsOptions.subject = 'events.mutated'
		await kafka.startConsumer!(async() => undefined)
		await nats.startConsumer!(async() => undefined)
		expect(kafkaSubscribe).toHaveBeenCalledWith(['events.original'], expect.any(Function))
		expect(natsSubscribe).toHaveBeenCalledWith('events.original', expect.any(Function))
	})

	it('resets the delivery attempt budget when retrying a dead letter', async() => {
		let now = 0
		const deliver = vi.fn()
			.mockResolvedValueOnce({status: 'permanent-failure'})
			.mockResolvedValueOnce({status: 'retryable'})
			.mockResolvedValue({status: 'success'})
		const runtime = await createEventsManager({
			clock: {now: () => now},
			backend: createMemoryEventsBackend(),
			role: 'combined', inline: true, maxAttempts: 2,
			destinations: [{name: 'remote', kind: 'custom', deliver}]
		})
		runtime.events.registerDefinition({
			type: 'dead.retry', source: 'test', schema,
			binding: {destination: 'remote', target: 'remote'}
		})
		runtime.events.registerConsumer({name: 'trigger-consumer', eventTypes: ['trigger']}, async() => undefined)
		await runtime.events.start()
		const dead = await runtime.events.publish('dead.retry', {value: 'dead'})
		await expect(runtime.admin!.retryDeadLetter(dead.id)).resolves.toBe(true)
		now = 1_000
		await runtime.events.publish('trigger', {})
		expect(runtime.events.getStatus()).toMatchObject({retriedTotal: 1, deadLetteredTotal: 1})
		expect(await runtime.admin!.listDeadLetters()).toHaveLength(0)
		await runtime.events.shutdown()
	})

	it('rolls back root registration without leaking capability bindings', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		await expect(registerEvents(container, {
			preset: 'development',
			definitions: [
				{type: 'duplicate', source: 'test', schema},
				{type: 'duplicate', source: 'test', schema}
			]
		})).rejects.toThrow('EVENTS_DEFINITION_INVALID')
		expect(container.has(TOK.Events)).toBe(false)
		expect(container.has(TOK.EventsAdmin)).toBe(false)
		expect(container.has(TOK.EventsTransactional)).toBe(false)
	})

	it('contains rejected promise owners at public construction and registration boundaries', async() => {
		await expect(createProductionEvents(Promise.reject(new Error('options owner')) as never))
			.rejects.toThrow('EVENTS_DURABLE_BACKEND_REQUIRED')
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		await expect(registerEvents(container, Promise.reject(new Error('configuration owner')) as never))
			.rejects.toThrow('EVENTS_REGISTRATION_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains every rejected promise in nested option and capability surfaces', async() => {
		const backend = {
			durability: 'durable',
			outbox: {
				append: Promise.reject(new Error('append method rejection')),
				claimDue: Promise.reject(new Error('claim method rejection'))
			},
			compatibility: {check: async() => ({compatible: true})}
		}
		await expect(createProductionEvents({backend: backend as never, role: 'publisher', clock}))
			.rejects.toThrow('EVENTS_EXTENSION_INVALID')
		await expect(createCustomEvents({
			backend: undefined as never,
			role: 'publisher',
			delivery: {
				pollIntervalMs: Promise.reject(new Error('poll option rejection')) as never,
				shutdownTimeoutMs: Promise.reject(new Error('shutdown option rejection')) as never
			}
		})).rejects.toThrow('EVENTS_BACKEND_REQUIRED')
		expect(() => createKafkaEventTransport({
			producer: {send: Promise.reject(new Error('send method rejection'))} as never,
			consumer: {subscribe: Promise.reject(new Error('subscribe method rejection'))} as never,
			allowedTopics: []
		})).toThrow('EVENTS_KAFKA_TOPICS_INVALID')
		expect(() => createHttpWebhookEventTransport({
			allowedOrigins: [],
			signing: {
				secret: Promise.reject(new Error('secret option rejection')) as never,
				headerName: Promise.reject(new Error('header option rejection')) as never
			}
		})).toThrow('EVENTS_HTTP_ORIGINS_INVALID')
		expect(() => createPostgresEventsBackend({
			client: {query: Promise.reject(new Error('query method rejection'))} as never,
			tablePrefix: 'INVALID'
		})).toThrow('EVENTS_TABLE_PREFIX_INVALID')
		const malformedPostgres = createPostgresEventsBackend({client: {query: async() => ({
			rows: Promise.reject(new Error('postgres rows rejection')),
			rowCount: Promise.reject(new Error('postgres row count rejection'))
		}) as never}})
		await expect(malformedPostgres.compatibility!.check()).resolves.toEqual({
			compatible: false, code: 'EVENTS_SCHEMA_CHECK_FAILED'
		})
		expect(() => createKafkaEventTransport({
			producer: {send: async() => undefined},
			allowedTopics: [
				Promise.reject(new Error('first topic rejection')),
				Promise.reject(new Error('second topic rejection'))
			] as never
		})).toThrow('EVENTS_KAFKA_TOPICS_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('contains every rejected field in an invalid destination result', async() => {
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true,
			maxAttempts: 1,
			destinations: [{name: 'invalid-result', kind: 'custom', deliver: async() => ({
				status: Promise.reject(new Error('status rejection')),
				retryAfterMs: Promise.reject(new Error('retry delay rejection'))
			}) as never}]
		})
		runtime.events.registerDefinition({
			type: 'invalid.result', source: 'test', schema,
			binding: {destination: 'invalid-result', target: 'target'}
		})
		await runtime.events.start()
		await runtime.events.publish('invalid.result', {value: 'test'})
		await expect(runtime.admin!.listDeadLetters()).resolves.toHaveLength(1)
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		await runtime.events.shutdown()
	})

	it('enforces production durability and atomic inbox capability gates', async() => {
		await expect(createProductionEvents({
			backend: createMemoryEventsBackend(), role: 'publisher', clock
		})).rejects.toThrow('EVENTS_DURABLE_BACKEND_REQUIRED')
		const memory = createMemoryEventsBackend()
		await expect(createProductionEvents({
			backend: {
				durability: 'durable', outbox: memory.outbox,
				compatibility: {check: async() => ({compatible: true})}
			},
			role: 'worker', clock
		})).rejects.toThrow('EVENTS_ATOMIC_INBOX_REQUIRED')
		const getter = vi.fn(() => 'durable')
		const accessorBackend = Object.defineProperty({}, 'durability', {enumerable: true, get: getter})
		await expect(createProductionEvents({backend: accessorBackend as never, role: 'publisher', clock}))
			.rejects.toThrow('EVENTS_DURABLE_BACKEND_REQUIRED')
		expect(getter).not.toHaveBeenCalled()
		await expect(createProductionEvents({
			backend: Promise.reject(new Error('backend rejection')) as never,
			role: Promise.reject(new Error('role rejection')) as never,
			clock
		})).rejects.toThrow('EVENTS_DURABLE_BACKEND_REQUIRED')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('preserves epoch-zero expiration timestamps', async() => {
		let now = -1_000
		const runtime = await createEventsManager({
			clock: {now: () => now}, backend: createMemoryEventsBackend(), role: 'publisher'
		})
		await runtime.events.start()
		const event = await runtime.events.publish('epoch.expiry', {}, {expiresAt: new Date(0)})
		expect(event.expiresAt).toBe(new Date(0).toISOString())
		now = 1
		await expect(runtime.admin!.purgeExpired()).resolves.toBe(1)
		await runtime.events.shutdown()
	})

	it('rejects publication windows that expire before scheduled delivery', async() => {
		const runtime = await createEventsManager({clock: {now: () => 1_000}, backend: createMemoryEventsBackend(), role: 'publisher'})
		await runtime.events.start()
		await expect(runtime.events.publish('scheduled.invalid', {}, {
			availableAt: new Date(3_000),
			expiresAt: new Date(2_000)
		})).rejects.toThrow('EVENTS_TIME_INVALID')
		expect(await runtime.admin!.listOutbox()).toHaveLength(0)
		await runtime.events.shutdown()
	})

	it('preserves inbound scheduling and expiration metadata in the durable record', async() => {
		let receive!: (event: never) => Promise<void>
		const backend = createMemoryEventsBackend()
		const append = vi.spyOn(backend.outbox, 'append')
		const runtime = await createEventsManager({
			clock: {now: () => 1_000},
			backend,
			role: 'worker',
			pollIntervalMs: 2_147_483_647,
			destinations: [{
				name: 'input', kind: 'custom', deliver: async() => undefined,
				startConsumer: async(callback) => { receive = callback as typeof receive; return async() => undefined }
			}]
		})
		await runtime.events.start()
		await receive({
			id: 'scheduled-inbound', type: 'scheduled.inbound', specVersion: '1.0', source: 'test',
			occurredAt: new Date(1_000).toISOString(), availableAt: new Date(2_000).toISOString(),
			expiresAt: new Date(3_000).toISOString(), headers: {}, payload: {}
		} as never)
		const record = append.mock.calls.at(-1)?.[0][0]
		expect(record).toMatchObject({availableAt: 2_000, expiresAt: 3_000})
		await receive({
			id: 'immediate-inbound', type: 'scheduled.inbound', specVersion: '1.0', source: 'test',
			occurredAt: new Date(500).toISOString(), headers: {}, payload: {}
		} as never)
		expect(append.mock.calls.at(-1)?.[0][0]).toMatchObject({availableAt: 1_000})

		await expect(receive({
			id: 'invalid-inbound', type: 'scheduled.inbound', specVersion: '1.0', source: 'test',
			occurredAt: new Date(1_000).toISOString(), availableAt: new Date(3_000).toISOString(),
			expiresAt: new Date(2_000).toISOString(), headers: {}, payload: {}
		} as never)).rejects.toThrow('EVENTS_ENVELOPE_INVALID')
		expect(append).toHaveBeenCalledTimes(2)
		await runtime.events.shutdown()
	})

	it('clears completed inbox claims when replaying an event', async() => {
		const consumer = vi.fn()
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend(),
			role: 'combined',
			inline: true
		})
		runtime.events.registerDefinition({type: 'replay.event', source: 'test', schema})
		runtime.events.registerConsumer({name: 'replay-consumer', eventTypes: ['replay.event']}, consumer)
		await runtime.events.start()
		const event = await runtime.events.publish('replay.event', {value: 'first'})
		expect(consumer).toHaveBeenCalledTimes(1)
		await expect(runtime.admin!.replay({eventId: event.id})).resolves.toBe(1)
		await runtime.events.publish('replay.trigger', {})
		expect(consumer).toHaveBeenCalledTimes(2)
		await runtime.events.shutdown()

		const query = vi.fn(async() => ({rows: [{count: '1'}], rowCount: 1}))
		const postgres = createPostgresEventsBackend({client: {query}})
		await expect(postgres.admin!.replay({eventId: event.id, limit: 1}, Date.now())).resolves.toBe(1)
		expect(query.mock.calls[0]![0]).toContain('DELETE FROM events_inbox')
	})

	it('snapshots broker messages once and rejects oversized binary data before decoding', async() => {
		let kafkaHandler!: (message: {topic: string; value: string}) => Promise<void>
		let natsHandler!: (message: {subject: string; data: Uint8Array | string}) => Promise<void>
		const kafkaEvent = vi.fn()
		const natsEvent = vi.fn()
		const kafka = createKafkaEventTransport({
			producer: {send: async() => undefined},
			consumer: {subscribe: async(_topics, handler) => { kafkaHandler = handler; return async() => undefined }},
			topics: ['events.test'], allowedTopics: ['events.test'], maxMessageBytes: 1_000
		})
		const nats = createNatsEventTransport({
			publisher: {publish: async() => undefined},
			subscriber: {subscribe: async(_subject, handler) => { natsHandler = handler; return async() => undefined }},
			subject: 'events.test', allowedSubjects: ['events.test'], maxMessageBytes: 1_000
		})
		await kafka.startConsumer!(kafkaEvent)
		await nats.startConsumer!(natsEvent)
		const envelope = JSON.stringify({
			id: 'event', type: 'test.created', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		})
		const getter = vi.fn(() => envelope)
		await kafkaHandler(Object.defineProperty({topic: 'events.test'}, 'value', {enumerable: true, get: getter}) as never)
		expect(getter).not.toHaveBeenCalled()
		expect(kafkaEvent).not.toHaveBeenCalled()
		await kafkaHandler({topic: 'events.test', value: envelope})
		expect(kafkaEvent).toHaveBeenCalledTimes(1)
		await natsHandler({subject: 'events.test', data: new Uint8Array(1_001)})
		expect(natsEvent).not.toHaveBeenCalled()
		const prefix = new TextEncoder().encode('{"value":"')
		const suffix = new TextEncoder().encode('"}')
		await natsHandler({subject: 'events.test', data: new Uint8Array([...prefix, 0xff, ...suffix])})
		expect(natsEvent).not.toHaveBeenCalled()
		const permanent = Object.assign(new Error('invalid ingress'), {permanent: true, ingress: true})
		kafkaEvent.mockRejectedValueOnce(permanent)
		await expect(kafkaHandler({topic: 'events.test', value: envelope})).resolves.toBeUndefined()
		kafkaEvent.mockRejectedValueOnce(new Error('backend unavailable'))
		await expect(kafkaHandler({topic: 'events.test', value: envelope})).rejects.toThrow('backend unavailable')
		kafkaEvent.mockRejectedValueOnce(Object.assign(new Error('backend collision'), {permanent: true}))
		await expect(kafkaHandler({topic: 'events.test', value: envelope})).rejects.toThrow('backend collision')
		kafkaEvent.mockRejectedValueOnce(Object.assign(new Error('unsafe Kafka metadata'), {
			ingress: Promise.reject(new Error('unsafe Kafka ingress')),
			permanent: Promise.reject(new Error('unsafe Kafka permanent'))
		}))
		await expect(kafkaHandler({topic: 'events.test', value: envelope})).rejects.toThrow('unsafe Kafka metadata')
		natsEvent.mockRejectedValueOnce(permanent)
		await expect(natsHandler({subject: 'events.test', data: new TextEncoder().encode(envelope)})).resolves.toBeUndefined()
		natsEvent.mockRejectedValueOnce(new Error('backend unavailable'))
		await expect(natsHandler({subject: 'events.test', data: new TextEncoder().encode(envelope)}))
			.rejects.toThrow('backend unavailable')
		natsEvent.mockRejectedValueOnce(Object.assign(new Error('unsafe NATS metadata'), {
			ingress: Promise.reject(new Error('unsafe NATS ingress')),
			permanent: Promise.reject(new Error('unsafe NATS permanent'))
		}))
		await expect(natsHandler({subject: 'events.test', data: envelope})).rejects.toThrow('unsafe NATS metadata')
		await kafkaHandler(Promise.reject(new Error('kafka message owner')) as never)
		await natsHandler({subject: 'events.test', data: Promise.reject(new Error('nats data field'))} as never)
		kafkaEvent.mockImplementationOnce(() => { throw Promise.reject(new Error('kafka callback reason')) })
		await expect(kafkaHandler({topic: 'events.test', value: envelope})).rejects.toBeInstanceOf(Promise)
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('bounds definition and consumer registration memory', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		expect(() => runtime.events.registerDefinition({
			type: 'large.source', source: 'x'.repeat(257), schema
		})).toThrow('EVENTS_DEFINITION_INVALID')
		expect(() => runtime.events.registerDefinition({
			type: 'large.tags', source: 'test', schema, tags: Array.from({length: 33}, (_, index) => String(index))
		})).toThrow('EVENTS_DEFINITION_INVALID')
		expect(() => runtime.events.registerConsumer({
			name: 'large-consumer', eventTypes: Array.from({length: 65}, (_, index) => `event.${index}`)
		}, async() => undefined)).toThrow('EVENTS_CONSUMER_INVALID')
		await runtime.events.shutdown()
	})

	it('enforces an aggregate byte budget for publication batches', async() => {
		const runtime = await createEventsManager({clock, backend: createMemoryEventsBackend(), role: 'publisher'})
		const requests = Array.from({length: 9}, (_, index) => ({
			type: `large.batch.${index}`,
			payload: {value: 'x'.repeat(999_000)}
		}))
		await expect(runtime.events.publishMany(requests)).rejects.toThrow('EVENTS_BATCH_LIMIT')
		expect(await runtime.admin!.listOutbox()).toHaveLength(0)
		await runtime.events.shutdown()
	})

	it('bounds concurrent inbound transport admission', async() => {
		let receive!: (event: never) => Promise<void>
		let finishAppend!: () => void
		const backend = createMemoryEventsBackend()
		const append = vi.fn(() => new Promise<void>((resolve) => { finishAppend = resolve }))
		const runtime = await createEventsManager({
			clock,
			backend: {...backend, outbox: {...backend.outbox, append}},
			role: 'worker',
			maxConcurrent: 1,
			destinations: [{
				name: 'input', kind: 'custom', deliver: async() => undefined,
				startConsumer: async(callback) => { receive = callback as typeof receive; return async() => undefined }
			}]
		})
		await runtime.events.start()
		const envelope = {
			id: 'one', type: 'inbound.event', specVersion: '1.0', source: 'test',
			occurredAt: new Date().toISOString(), headers: {}, payload: {}
		}
		const first = receive(envelope as never)
		await Promise.resolve()
		await expect(receive({...envelope, id: 'two'} as never)).rejects.toThrow('EVENTS_INGRESS_BUSY')
		finishAppend()
		await first
		const shutdown = runtime.events.shutdown()
		await expect(receive({...envelope, id: 'three'} as never)).rejects.toThrow('EVENTS_ADMISSION_CLOSED')
		await shutdown
	})

	it('enforces aggregate memory backend byte capacity atomically', async() => {
		const runtime = await createEventsManager({
			clock,
			backend: createMemoryEventsBackend({maxBytes: 1_000_000}),
			role: 'publisher'
		})
		await runtime.events.start()
		await runtime.events.publish('memory.one', {value: 'x'.repeat(600_000)})
		await expect(runtime.events.publish('memory.two', {value: 'x'.repeat(600_000)}))
			.rejects.toThrow('EVENTS_BACKEND_CAPACITY')
		expect(await runtime.admin!.listOutbox()).toHaveLength(1)
		await runtime.events.shutdown()
	})

	it('accounts outbox lease mutations against the memory byte budget atomically', async() => {
		const backend = createMemoryEventsBackend({maxRecords: 1, maxBytes: 1_000_000})
		const record = {
			envelope: {
				id: 'capacity-event', type: 'test.created', specVersion: '1.0' as const, source: 'test',
				occurredAt: new Date(0).toISOString(), headers: {}, payload: {value: ''}
			},
			status: 'queued' as const, attempts: 0, availableAt: 0, createdAt: 0, updatedAt: 0
		}
		const overhead = Buffer.byteLength(JSON.stringify(record))
		record.envelope.payload.value = 'x'.repeat(1_000_000 - overhead - 8)
		await backend.outbox.append([record])
		await expect(backend.outbox.claimDue({now: 0, limit: 1, owner: 'worker', leaseMs: 30_000}))
			.rejects.toThrow('EVENTS_BACKEND_CAPACITY')
		await expect(backend.admin!.listOutbox()).resolves.toEqual([
			expect.objectContaining({eventId: 'capacity-event', status: 'queued'})
		])
	})

	it('accounts inbox deduplication records against the memory byte budget', async() => {
		const backend = createMemoryEventsBackend({maxRecords: 1, maxBytes: 1_000_000})
		const owner = 'o'.repeat(256)
		let rejectedAt = -1
		for (let index = 0; index < 5_000; index++) {
			try {
				await backend.inbox!.claim({
					consumer: `consumer-${index}`,
					eventId: `event-${index}`,
					owner,
					now: 0,
					expiresAt: 30_000
				})
			} catch(error) {
				expect(error).toMatchObject({message: 'EVENTS_BACKEND_CAPACITY'})
				rejectedAt = index
				break
			}
		}
		expect(rejectedAt).toBeGreaterThan(0)
		await expect(backend.inbox!.release({consumer: 'consumer-0', eventId: 'event-0', owner})).resolves.toBe(true)
		await expect(backend.inbox!.claim({
			consumer: `consumer-${rejectedAt}`,
			eventId: `event-${rejectedAt}`,
			owner,
			now: 0,
			expiresAt: 30_000
		})).resolves.toBe('claimed')
	})
})
