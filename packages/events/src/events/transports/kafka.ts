import {AsyncLocalStorage} from 'node:async_hooks'

import type {EventEnvelope} from '@ooopsstudio/core/contracts/events'
import {captureSyncMethod, isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {inputField, inputList, isolateCapabilityFields, isolateInputFields} from '../safe-input'
import type {EventDestination} from '../types'

export interface KafkaProducerClient {
	send(input: {topic: string; messages: {key?: string; value: string; headers?: Record<string, string>}[]}): Promise<void>
}
export interface KafkaConsumerClient {
	subscribe(topics: readonly string[], handler: (message: {topic: string; value: string; headers?: Record<string, string>}) => Promise<void>): Promise<() => void | Promise<void>>
}
export interface KafkaEventTransportOptions {
	readonly name?: string
	readonly producer: KafkaProducerClient
	readonly consumer?: KafkaConsumerClient
	readonly topics?: readonly string[]
	readonly allowedTopics: readonly string[]
	readonly maxMessageBytes?: number
	readonly timeoutMs?: number
}

const timeout = async<T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([work, new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error('EVENTS_KAFKA_TIMEOUT')), ms)
		})])
	} finally { if (timer) clearTimeout(timer) }
}

export function createKafkaEventTransport(options: KafkaEventTransportOptions): EventDestination {
	isolateInputFields(options, ['name', 'producer', 'consumer', 'topics', 'allowedTopics', 'maxMessageBytes', 'timeoutMs'])
	const producer = inputField(options, 'producer', 'EVENTS_KAFKA_PRODUCER_INVALID')
	const consumer = inputField(options, 'consumer', 'EVENTS_KAFKA_CONSUMER_INVALID')
	isolateCapabilityFields(producer, ['send'])
	isolateCapabilityFields(consumer, ['subscribe'])
	const allowedInput = inputList(inputField(options, 'allowedTopics', 'EVENTS_KAFKA_TOPICS_INVALID'), 256, 'EVENTS_KAFKA_TOPICS_INVALID')
	const allowed = new Set(allowedInput)
	if ([...allowed].some((value) => typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,249}$/u.test(value))) throw new Error('EVENTS_KAFKA_TOPICS_INVALID')
	const send = captureSyncMethod<[Parameters<KafkaProducerClient['send']>[0]], ReturnType<KafkaProducerClient['send']>>(producer, 'send')
	if (!send) throw new Error('EVENTS_KAFKA_PRODUCER_INVALID')
	const subscribe = consumer === undefined ? undefined : captureSyncMethod<Parameters<KafkaConsumerClient['subscribe']>, ReturnType<KafkaConsumerClient['subscribe']>>(consumer, 'subscribe')
	if (consumer !== undefined && !subscribe) throw new Error('EVENTS_KAFKA_CONSUMER_INVALID')
	const inputTopics = inputField(options, 'topics', 'EVENTS_KAFKA_TOPIC_REJECTED')
	const topics = inputTopics === undefined ? undefined : inputList(inputTopics, 256, 'EVENTS_KAFKA_TOPIC_REJECTED') as readonly string[]
	if (topics?.some((value) => !allowed.has(value))) throw new Error('EVENTS_KAFKA_TOPIC_REJECTED')
	const maximum = (inputField(options, 'maxMessageBytes', 'EVENTS_KAFKA_LIMITS_INVALID') ?? 1_000_000) as number
	const timeoutMs = (inputField(options, 'timeoutMs', 'EVENTS_KAFKA_LIMITS_INVALID') ?? 10_000) as number
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16_000_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('EVENTS_KAFKA_LIMITS_INVALID')
	const nameInput = inputField(options, 'name', 'EVENTS_KAFKA_NAME_INVALID')
	const name = nameInput === undefined ? 'kafka' : nameInput
	if (typeof name !== 'string' || !name || name.length > 128) throw new Error('EVENTS_KAFKA_NAME_INVALID')
	let closed = false
	let inboundActive = 0
	let shutdownFlight: Promise<void> | undefined
	let shutdownSkipsActive = false
	const active = new Set<Promise<unknown>>()
	const stops = new Set<() => void | Promise<void>>()
	const clientContext = new AsyncLocalStorage<{active: boolean}>()
	const permanentIngress = (error: unknown): boolean => {
		if (isolateUnexpectedThenable(error) || !error || (typeof error !== 'object' && typeof error !== 'function')) return false
		isolateInputFields(error, ['ingress', 'permanent'])
		try {
			return Object.getOwnPropertyDescriptor(error, 'ingress')?.value === true
				&& Object.getOwnPropertyDescriptor(error, 'permanent')?.value === true
		} catch(error) { isolateUnexpectedThenable(error); return false }
	}
	const runClient = <T>(work: () => Promise<T> | T): Promise<T> => {
		const marker = {active: true}
		return clientContext.run(marker, async() => {
			try { return await work() }
			catch(error) { isolateUnexpectedThenable(error); throw error }
			finally { marker.active = false }
		})
	}
	const stopOne = async(stop: () => void | Promise<void>): Promise<void> => {
		if (!stops.delete(stop)) return
		try { await stop() } catch(error) { isolateUnexpectedThenable(error); stops.add(stop); throw error }
	}
	return {
		name,
		kind: 'kafka',
		async deliver(event, binding) {
			if (closed) return {status: 'retryable'}
			if (!allowed.has(binding.target)) return {status: 'permanent-failure'}
			const value = JSON.stringify(event)
			if (Buffer.byteLength(value) > maximum) return {status: 'permanent-failure'}
			let physical: Promise<void>
			try { physical = runClient(() => send({topic: binding.target, messages: [{key: event.partitionKey, value, headers: {'x-event-type': event.type}}]})) }
			catch(error) { isolateUnexpectedThenable(error); return {status: 'retryable'} }
			active.add(physical)
			try {
				try { await timeout(physical, timeoutMs) }
				catch(error) {
					if (!(error instanceof Error) || error.message !== 'EVENTS_KAFKA_TIMEOUT') throw error
					await physical
				}
				return {status: 'success'}
			} catch(error) { isolateUnexpectedThenable(error); return {status: 'retryable'} }
			finally { active.delete(physical) }
		},
		async startConsumer(onEvent) {
			if (!subscribe || !topics || closed) return () => {}
			const starting = runClient(async() => {
				const handle = (message: {topic: string; value: string; headers?: Record<string, string>}): Promise<void> => {
					const work = runClient(async() => {
						if (closed) return
						if (inboundActive >= 32) throw new Error('EVENTS_INGRESS_BUSY')
						inboundActive++
						try {
							let topic: unknown
							let value: unknown
							try {
								topic = inputField(message, 'topic', 'EVENTS_KAFKA_MESSAGE_INVALID')
								value = inputField(message, 'value', 'EVENTS_KAFKA_MESSAGE_INVALID')
							} catch { return }
							if (!allowed.has(topic) || typeof value !== 'string' || Buffer.byteLength(value) > maximum) return
							let event: EventEnvelope
							try { event = JSON.parse(value) as EventEnvelope } catch { return }
							try { await onEvent(event) } catch(error) { if (!permanentIngress(error)) throw error }
						} finally { inboundActive-- }
					})
					active.add(work)
					void work.finally(() => active.delete(work)).catch(() => {})
					return work
				}
				const stop = await subscribe(topics, handle)
				if (typeof stop !== 'function') throw new Error('EVENTS_KAFKA_CONSUMER_INVALID')
				stops.add(stop)
				if (closed) { await stopOne(stop); return () => {} }
				return () => stopOne(stop)
			})
			active.add(starting)
			try { return await starting }
			catch(error) { isolateUnexpectedThenable(error); throw error }
			finally { active.delete(starting) }
		},
		async flush() {
			if (clientContext.getStore()?.active) return
			await timeout(Promise.allSettled([...active]).then(() => undefined), timeoutMs)
		},
		async shutdown() {
			const internal = clientContext.getStore()?.active === true
			if (shutdownFlight) {
				if (internal) return
				const existing = shutdownFlight
				const skipsActive = shutdownSkipsActive
				await existing
				if (!skipsActive) return
			}
			closed = true
			let begin!: () => void
			const gate = new Promise<void>((resolve) => { begin = resolve })
			shutdownSkipsActive = Boolean(internal)
			const flight = gate.then(async() => {
				if (!internal) await timeout(Promise.allSettled([...active]).then(() => undefined), timeoutMs)
				const stopping = [...stops].map((stop) => {
					const work = stopOne(stop)
					active.add(work)
					void work.finally(() => active.delete(work)).catch(() => {})
					return work
				})
				const results = await timeout(Promise.allSettled(stopping), timeoutMs)
				const failure = results.find((result) => result.status === 'rejected')
				if (failure?.status === 'rejected') { isolateUnexpectedThenable(failure.reason); throw failure.reason }
				if (!internal) await timeout(Promise.allSettled([...active]).then(() => undefined), timeoutMs)
			})
			shutdownFlight = flight
			begin()
			if (internal) {
				void flight.finally(() => { if (shutdownFlight === flight) { shutdownFlight = undefined; shutdownSkipsActive = false } }).catch(() => {})
				return
			}
			try { await flight } finally { if (shutdownFlight === flight) { shutdownFlight = undefined; shutdownSkipsActive = false } }
		}
	}
}
