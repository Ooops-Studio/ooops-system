import {createContainer} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerEvents} from '../../src/events'
import {createMemoryEventsBackend} from '../../src/events/memory-backend'

const clock = {now: () => Date.now()}

describe('events registration hardening', () => {
	it('rejects accessor-backed configuration without invoking it', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		let invoked = false
		const configuration = Object.defineProperty({}, 'preset', {
			enumerable: true,
			get() { invoked = true; return 'development' }
		})
		await expect(registerEvents(container, configuration as never)).rejects.toThrow('EVENTS_REGISTRATION_INVALID')
		expect(invoked).toBe(false)
		expect(container.has(TOK.Events)).toBe(false)
	})

	it('contains rejected promises supplied in synchronous registration fields', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		await expect(registerEvents(container, {
			preset: Promise.reject(new Error('preset rejection'))
		} as never)).rejects.toThrow('EVENTS_REGISTRATION_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		expect(container.has(TOK.Events)).toBe(false)
	})

	it('contains nested rejections across every invalid registration definition', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		await expect(registerEvents(container, {
			preset: 'development',
			definitions: [{
				type: 'first', source: 'test', schema: {
					parse: Promise.reject(new Error('first parser rejection'))
				},
				defaultHeaders: {value: Promise.reject(new Error('first header rejection'))}
			}, {
				type: 'second', source: 'test', schema: {
					parse: Promise.reject(new Error('second parser rejection'))
				},
				binding: {destination: 'target', target: 'target', options: {
					value: Promise.reject(new Error('second binding rejection'))
				}}
			}]
		} as never)).rejects.toThrow('EVENTS_REGISTRATION_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
		expect(container.has(TOK.Events)).toBe(false)
	})

	it('contains a rejected container owner before configuration validation', async() => {
		await expect(registerEvents(
			Promise.reject(new Error('container rejection')) as never,
			Promise.reject(new Error('configuration rejection')) as never
		)).rejects.toThrow('EVENTS_CONTAINER_INVALID')
		await new Promise<void>((resolve) => { setImmediate(resolve) })
	})

	it('rejects accessor-backed optional cleanup capabilities without invoking them', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		const getter = vi.fn(() => async() => undefined)
		const destination = Object.defineProperty({
			name: 'outbound', kind: 'custom', deliver: async() => undefined
		}, 'shutdown', {enumerable: true, get: getter})
		await expect(registerEvents(container, {
			preset: 'custom',
			options: {backend: createMemoryEventsBackend(), role: 'publisher', destinations: [destination]}
		} as never)).rejects.toThrow('EVENTS_REGISTRATION_INVALID')
		expect(getter).not.toHaveBeenCalled()
		expect(container.has(TOK.Events)).toBe(false)
	})

	it('preserves receiver semantics for container capabilities', async() => {
		class ReceiverContainer {
			readonly values = new Map<symbol, unknown>()
			bind(token: symbol, value: unknown) { this.values.set(token, value) }
			unbind(token: symbol) { return this.values.delete(token) }
			get(token: symbol) { if (!this.values.has(token)) throw new Error('missing'); return this.values.get(token) }
			tryGet(token: symbol) { return this.values.get(token) }
			has(token: symbol) { return this.values.has(token) }
		}
		const container = new ReceiverContainer()
		container.bind(TOK.Clock, clock)
		await registerEvents(container, {preset: 'development'} as never)
		expect(container.has(TOK.Events)).toBe(true)
		await (container.get(TOK.Events) as {shutdown(): Promise<void>}).shutdown()
	})

	it('rolls back owned capabilities without removing a foreign retained binding', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, clock]])
		const alien = Object.freeze({alien: true})
		const container = {
			bind(token: symbol, value: unknown) { values.set(token, token === TOK.EventsAdmin ? alien : value) },
			unbind(token: symbol) { return values.delete(token) },
			get(token: symbol) { if (!values.has(token)) throw new Error('missing'); return values.get(token) },
			tryGet(token: symbol) { return values.get(token) },
			has(token: symbol) { return values.has(token) }
		}
		await expect(registerEvents(container, {preset: 'development'} as never)).rejects.toThrow()
		expect(values.has(TOK.Events)).toBe(false)
		expect(values.get(TOK.EventsAdmin)).toBe(alien)
		expect(values.has(TOK.EventsTransactional)).toBe(false)
	})

	it('rolls back a binding that is installed before bind throws', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, clock]])
		const container = {
			bind(token: symbol, value: unknown) {
				values.set(token, value)
				if (token === TOK.Events) throw new Error('hostile bind failure')
			},
			unbind(token: symbol) { return values.delete(token) },
			get(token: symbol) { if (!values.has(token)) throw new Error('missing'); return values.get(token) },
			tryGet(token: symbol) { return values.get(token) },
			has(token: symbol) { return values.has(token) }
		}
		await expect(registerEvents(container, {preset: 'development'} as never)).rejects.toThrow('hostile bind failure')
		expect(values.has(TOK.Events)).toBe(false)
		expect(values.has(TOK.EventsAdmin)).toBe(false)
	})

	it('rolls back a binding when ownership verification throws after installation', async() => {
		const values = new Map<symbol, unknown>([[TOK.Clock, clock]])
		let failVerification = true
		const container = {
			bind(token: symbol, value: unknown) { values.set(token, value) },
			unbind(token: symbol) { return values.delete(token) },
			get(token: symbol) { if (!values.has(token)) throw new Error('missing'); return values.get(token) },
			tryGet(token: symbol) {
				if (token === TOK.Events && values.has(token) && failVerification) {
					failVerification = false
					throw new Error('hostile verification failure')
				}
				return values.get(token)
			},
			has(token: symbol) { return values.has(token) }
		}
		await expect(registerEvents(container, {preset: 'development'} as never))
			.rejects.toThrow('hostile verification failure')
		expect(values.has(TOK.Events)).toBe(false)
		expect(values.has(TOK.EventsAdmin)).toBe(false)
	})

	it('rejects sparse definition arrays before creating a runtime', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		const definitions = new Array(1)
		await expect(registerEvents(container, {preset: 'development', definitions} as never))
			.rejects.toThrow('EVENTS_REGISTRATION_INVALID')
		expect(container.has(TOK.Events)).toBe(false)
	})

	it('snapshots destination policy before the first lazy registration await', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		const originalDeliver = vi.fn(async() => undefined)
		const injectedDeliver = vi.fn(async() => undefined)
		const destinations = [{name: 'outbound', kind: 'custom' as const, deliver: originalDeliver}]
		const registration = registerEvents(container, {
			preset: 'custom',
			options: {backend: createMemoryEventsBackend(), role: 'combined', inline: true, destinations},
			definitions: [{
				type: 'registration.event', source: 'test', schema: {parse: (value: unknown) => value},
				binding: {destination: 'outbound', target: 'target'}
			}]
		} as never)
		destinations[0] = {name: 'outbound', kind: 'custom', deliver: injectedDeliver}
		await registration
		const events = container.get(TOK.Events) as {publish(type: string, payload: unknown): Promise<unknown>; shutdown(): Promise<void>}
		await events.publish('registration.event', {})
		expect(originalDeliver).toHaveBeenCalledTimes(1)
		expect(injectedDeliver).not.toHaveBeenCalled()
		await events.shutdown()
	})

	it('snapshots nested definition policy before lazy runtime creation', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, clock)
		const originalParse = vi.fn((value: unknown) => value)
		const injectedParse = vi.fn(() => { throw new Error('injected parser') })
		const schema = {parse: originalParse}
		const headers = {policy: {version: 1}}
		const binding = {destination: 'outbound', target: 'original', options: {policy: {version: 1}}}
		const deliver = vi.fn(async(_event, receivedBinding) => {
			expect(receivedBinding).toMatchObject({target: 'original', options: {policy: {version: 1}}})
		})
		const registration = registerEvents(container, {
			preset: 'custom',
			options: {backend: createMemoryEventsBackend(), role: 'combined', inline: true,
				destinations: [{name: 'outbound', kind: 'custom', deliver}]},
			definitions: [{type: 'registration.nested', source: 'test', schema, binding, defaultHeaders: headers}]
		} as never)
		schema.parse = injectedParse
		binding.target = 'injected'
		binding.options.policy.version = 2
		headers.policy.version = 2
		await registration
		const events = container.get(TOK.Events) as {publish(type: string, payload: unknown): Promise<{headers: unknown}>; shutdown(): Promise<void>}
		await expect(events.publish('registration.nested', {})).resolves.toMatchObject({headers: {policy: {version: 1}}})
		expect(originalParse).toHaveBeenCalled()
		expect(injectedParse).not.toHaveBeenCalled()
		expect(deliver).toHaveBeenCalledTimes(1)
		await events.shutdown()
	})
})
