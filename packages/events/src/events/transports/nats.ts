import {AsyncLocalStorage} from 'node:async_hooks'

import type {EventEnvelope} from '@ooopsstudio/core/contracts/events'
import {captureSyncMethod, isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {inputField, inputList, isolateCapabilityFields, isolateInputFields} from '../safe-input'
import type {EventDestination} from '../types'

export interface NatsPublisherClient {
	publish(subject: string, payload: Uint8Array | string, headers?: Record<string, string>): Promise<void> | void
}
export interface NatsSubscriberClient {
	subscribe(subject: string, handler: (message: {subject: string; data: Uint8Array | string; headers?: Record<string, string>}) => Promise<void>): Promise<() => void | Promise<void>>
}
export interface NatsEventTransportOptions {
	readonly name?: string
	readonly publisher: NatsPublisherClient
	readonly subscriber?: NatsSubscriberClient
	readonly subject?: string
	readonly allowedSubjects: readonly string[]
	readonly maxMessageBytes?: number
	readonly timeoutMs?: number
}

const timeout = async<T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([work, new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error('EVENTS_NATS_TIMEOUT')), ms)
		})])
	} finally { if (timer) clearTimeout(timer) }
}

export function createNatsEventTransport(options: NatsEventTransportOptions): EventDestination {
	isolateInputFields(options, ['name', 'publisher', 'subscriber', 'subject', 'allowedSubjects', 'maxMessageBytes', 'timeoutMs'])
	const publisher = inputField(options, 'publisher', 'EVENTS_NATS_PUBLISHER_INVALID')
	const subscriber = inputField(options, 'subscriber', 'EVENTS_NATS_SUBSCRIBER_INVALID')
	isolateCapabilityFields(publisher, ['publish'])
	isolateCapabilityFields(subscriber, ['subscribe'])
	const allowedInput = inputList(inputField(options, 'allowedSubjects', 'EVENTS_NATS_SUBJECTS_INVALID'), 256, 'EVENTS_NATS_SUBJECTS_INVALID')
	const allowed = new Set(allowedInput)
	if ([...allowed].some((value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(value))) throw new Error('EVENTS_NATS_SUBJECTS_INVALID')
	const publish = captureSyncMethod<Parameters<NatsPublisherClient['publish']>, ReturnType<NatsPublisherClient['publish']>>(publisher, 'publish')
	if (!publish) throw new Error('EVENTS_NATS_PUBLISHER_INVALID')
	const subscribe = subscriber === undefined ? undefined : captureSyncMethod<Parameters<NatsSubscriberClient['subscribe']>, ReturnType<NatsSubscriberClient['subscribe']>>(subscriber, 'subscribe')
	if (subscriber !== undefined && !subscribe) throw new Error('EVENTS_NATS_SUBSCRIBER_INVALID')
	const subject = inputField(options, 'subject', 'EVENTS_NATS_SUBJECT_REJECTED') as string | undefined
	if (subject !== undefined && (!subject || !allowed.has(subject))) throw new Error('EVENTS_NATS_SUBJECT_REJECTED')
	const max = (inputField(options, 'maxMessageBytes', 'EVENTS_NATS_LIMITS_INVALID') ?? 1_000_000) as number
	const timeoutMs = (inputField(options, 'timeoutMs', 'EVENTS_NATS_LIMITS_INVALID') ?? 10_000) as number
	if (!Number.isSafeInteger(max) || max < 1 || max > 16_000_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('EVENTS_NATS_LIMITS_INVALID')
	const nameInput = inputField(options, 'name', 'EVENTS_NATS_NAME_INVALID')
	const name = nameInput === undefined ? 'nats' : nameInput
	if (typeof name !== 'string' || !name || name.length > 128) throw new Error('EVENTS_NATS_NAME_INVALID')
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
	const decoder = new TextDecoder('utf-8', {fatal: true})
	return {
		name,
		kind: 'nats',
		async deliver(event, binding) {
			if (closed) return {status: 'retryable'}
			if (!allowed.has(binding.target)) return {status: 'permanent-failure'}
			const value = JSON.stringify(event)
			if (Buffer.byteLength(value) > max) return {status: 'permanent-failure'}
			let physical: Promise<void>
			try { physical = runClient(() => publish(binding.target, value, {'x-event-type': event.type})) }
			catch(error) { isolateUnexpectedThenable(error); return {status: 'retryable'} }
			active.add(physical)
			try {
				try { await timeout(physical, timeoutMs) }
				catch(error) {
					if (!(error instanceof Error) || error.message !== 'EVENTS_NATS_TIMEOUT') throw error
					await physical
				}
				return {status: 'success'}
			} catch(error) { isolateUnexpectedThenable(error); return {status: 'retryable'} }
			finally { active.delete(physical) }
		},
		async startConsumer(onEvent) {
			if (!subscribe) return () => {}
			if (!subject) throw new Error('EVENTS_NATS_SUBJECT_REJECTED')
			if (closed) return () => {}
			const starting = runClient(async() => {
				const handle = (message: {subject: string; data: Uint8Array | string; headers?: Record<string, string>}): Promise<void> => {
					const work = runClient(async() => {
						if (closed) return
						if (inboundActive >= 32) throw new Error('EVENTS_INGRESS_BUSY')
						inboundActive++
						try {
							let messageSubject: unknown
							let data: unknown
							try {
								messageSubject = inputField(message, 'subject', 'EVENTS_NATS_MESSAGE_INVALID')
								data = inputField(message, 'data', 'EVENTS_NATS_MESSAGE_INVALID')
							} catch { return }
							if (!allowed.has(messageSubject)) return
							let raw: string
							try {
								if (typeof data === 'string') {
									if (Buffer.byteLength(data) > max) return
									raw = data
								} else {
									if (!(data instanceof Uint8Array) || data.byteLength > max) return
									raw = decoder.decode(data)
								}
							} catch { return }
							let event: EventEnvelope
							try { event = JSON.parse(raw) as EventEnvelope } catch { return }
							try { await onEvent(event) } catch(error) { if (!permanentIngress(error)) throw error }
						} finally { inboundActive-- }
					})
					active.add(work)
					void work.finally(() => active.delete(work)).catch(() => {})
					return work
				}
				const stop = await subscribe(subject, handle)
				if (typeof stop !== 'function') throw new Error('EVENTS_NATS_SUBSCRIBER_INVALID')
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
