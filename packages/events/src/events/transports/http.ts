import {createHmac} from 'node:crypto'
import {lookup} from 'node:dns/promises'
import type {IncomingMessage} from 'node:http'
import {request} from 'node:https'
import {isIP} from 'node:net'

import {isolateUnexpectedThenable} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {isPublicNetworkAddress} from '@ooopsstudio/core/utils/public-network-address'

import {inputField, inputList, isolateInputFields} from '../safe-input'
import type {EventDestination} from '../types'

export interface HttpEventTransportOptions {
	readonly name?: string
	readonly allowedOrigins: readonly string[]
	readonly timeoutMs?: number
	readonly maxBodyBytes?: number
	readonly signing?: {readonly secret: string; readonly headerName?: string}
}

const forbidden = (address: string): boolean => !isPublicNetworkAddress(address)
const discard = (response: IncomingMessage): void => { response.on('error', () => {}); response.destroy() }
const retryAfterMs = (value: string | undefined): number | undefined => {
	if (!value) return undefined
	const seconds = Number(value)
	const duration = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now()
	return Number.isFinite(duration) ? Math.min(120_000, Math.max(0, duration)) : undefined
}
const RETRYABLE = 'retryable' as const
const PERMANENT = 'permanent-failure' as const
const DNS_FAILURE = {}

export function createHttpWebhookEventTransport(options: HttpEventTransportOptions): EventDestination {
	isolateInputFields(options, ['name', 'allowedOrigins', 'timeoutMs', 'maxBodyBytes', 'signing'])
	const signingInput = inputField(options, 'signing', 'EVENTS_HTTP_SIGNING_INVALID')
	isolateInputFields(signingInput, ['secret', 'headerName'])
	const origins = new Set<string>()
	const originInput = inputList(inputField(options, 'allowedOrigins', 'EVENTS_HTTP_ORIGINS_INVALID'), 64, 'EVENTS_HTTP_ORIGINS_INVALID')
	for (const raw of originInput) {
		if (typeof raw !== 'string') throw new Error('EVENTS_HTTP_ORIGINS_INVALID')
		const url = new URL(raw)
		if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('EVENTS_HTTP_ORIGINS_INVALID')
		origins.add(url.origin)
	}
	const timeoutMs = (inputField(options, 'timeoutMs', 'EVENTS_HTTP_LIMITS_INVALID') ?? 10_000) as number
	const maxBody = (inputField(options, 'maxBodyBytes', 'EVENTS_HTTP_LIMITS_INVALID') ?? 1_000_000) as number
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(maxBody) || maxBody < 1 || maxBody > 16_000_000) throw new Error('EVENTS_HTTP_LIMITS_INVALID')
	let signing: {secret: string; headerName: string} | undefined
	if (signingInput) {
		const rawHeader = inputField(signingInput, 'headerName', 'EVENTS_HTTP_SIGNING_INVALID') ?? 'x-ooops-signature'
		const secret = inputField(signingInput, 'secret', 'EVENTS_HTTP_SIGNING_INVALID')
		const header = typeof rawHeader === 'string' ? rawHeader.toLowerCase() : ''
		if (typeof secret !== 'string' || secret.length < 16 || secret.length > 4096 || !/^x-[a-z0-9-]{1,63}$/u.test(header) || header === 'x-event-id' || header === 'x-event-type') throw new Error('EVENTS_HTTP_SIGNING_INVALID')
		signing = Object.freeze({secret, headerName: header})
	}
	const nameInput = inputField(options, 'name', 'EVENTS_HTTP_NAME_INVALID')
	const name = nameInput === undefined ? 'http-webhook' : nameInput
	if (typeof name !== 'string' || !name || name.length > 128) throw new Error('EVENTS_HTTP_NAME_INVALID')
	let closed = false
	const active = new Set<Promise<unknown>>()
	const resolveAddresses = async(hostname: string, signal: AbortSignal): Promise<Array<{address: string; family: number}>> => {
		let timer: ReturnType<typeof setTimeout> | undefined
		let abort: (() => void) | undefined
		try {
			return await Promise.race([
				lookup(hostname, {all: true, verbatim: true}),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(DNS_FAILURE), timeoutMs) }),
				new Promise<never>((_, reject) => {
					abort = () => reject(DNS_FAILURE)
					signal.addEventListener('abort', abort, {once: true})
					if (signal.aborted) abort()
				})
			])
		} catch(error) { isolateUnexpectedThenable(error); throw DNS_FAILURE }
		finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
	}
	const validate = async(raw: string, signal: AbortSignal): Promise<{url: URL; hostname: string; address: string; family: 4 | 6}> => {
		if (raw.length > 2048) throw new Error('EVENTS_HTTP_TARGET_INVALID')
		const url = new URL(raw)
		if (url.protocol !== 'https:' || url.username || url.password || !origins.has(url.origin)) throw new Error('EVENTS_HTTP_TARGET_REJECTED')
		const hostname = url.hostname[0] === '[' ? url.hostname.slice(1, -1) : url.hostname
		const addresses = await resolveAddresses(hostname, signal)
		if (!addresses.length || addresses.length > 32 || addresses.some((entry) => forbidden(entry.address))) throw new Error('EVENTS_HTTP_ADDRESS_REJECTED')
		const selected = addresses[0]!
		return {url, hostname, address: selected.address, family: selected.family as 4 | 6}
	}
	const deliver = async(
		event: Parameters<EventDestination['deliver']>[0],
		binding: Parameters<EventDestination['deliver']>[1],
		signal: AbortSignal
	): Promise<{status: 'success' | 'retryable' | 'permanent-failure'; retryAfterMs?: number}> => {
		if (signal.aborted) return {status: RETRYABLE}
		let target: {url: URL; hostname: string; address: string; family: 4 | 6}
		try { target = await validate(binding.target, signal) }
		catch(error) { isolateUnexpectedThenable(error); return {status: error === DNS_FAILURE ? RETRYABLE : PERMANENT} }
		if (signal.aborted) return {status: RETRYABLE}
		const body = JSON.stringify(event)
		if (Buffer.byteLength(body) > maxBody) return {status: PERMANENT}
		const headers: Record<string, string | number> = {
			'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
			'user-agent': 'ooops-events/0.2', 'x-event-id': event.id, 'x-event-type': event.type
		}
		if (signing) headers[signing.headerName] = `sha256=${createHmac('sha256', signing.secret).update(body).digest('hex')}`
		return new Promise((resolve) => {
			let settled = false
			let timer: ReturnType<typeof setTimeout> | undefined
			const finish = (result: {status: 'success' | 'retryable' | 'permanent-failure'; retryAfterMs?: number}): void => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				signal.removeEventListener('abort', abort)
				resolve(result)
			}
			const req = request({
				protocol: 'https:', hostname: target.hostname, port: target.url.port || 443,
				path: `${target.url.pathname}${target.url.search}`, method: 'POST', headers,
				servername: isIP(target.hostname) ? undefined : target.hostname,
				lookup: (_hostname, _options, callback) => callback(null, target.address, target.family)
			}, (response) => {
				const status = response.statusCode ?? 0
				const raw = response.headers['retry-after']
				discard(response)
				if (status >= 200 && status < 300) return finish({status: 'success'})
				if (status === 429 || status >= 500) {
					const retry = retryAfterMs(typeof raw === 'string' ? raw : undefined)
					return finish({status: RETRYABLE, ...(retry === undefined ? {} : {retryAfterMs: retry})})
				}
				finish({status: PERMANENT})
			})
			const abort = (): void => { req.destroy(); finish({status: RETRYABLE}) }
			req.on('error', () => finish({status: RETRYABLE}))
			signal.addEventListener('abort', abort, {once: true})
			if (signal.aborted) return abort()
			timer = setTimeout(() => { req.destroy(); finish({status: RETRYABLE}) }, timeoutMs)
			req.end(body)
		})
	}
	return {
		name, kind: 'http',
		deliver(event, binding, signal) {
			if (closed) return Promise.resolve({status: RETRYABLE})
			const work = deliver(event, binding, signal)
			active.add(work)
			void work.finally(() => active.delete(work)).catch(() => {})
			return work
		},
		async flush() { await Promise.allSettled([...active]) },
		async shutdown() { closed = true; await Promise.allSettled([...active]) }
	}
}
