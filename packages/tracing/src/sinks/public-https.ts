import {lookup} from 'node:dns/promises'
import {request as httpsRequest} from 'node:https'
import {isIP} from 'node:net'

import {isPublicNetworkAddress} from '@ooopsstudio/core/utils/public-network-address'

const MAX_DNS_ANSWERS = 64
const MAX_PUBLIC_ADDRESSES = 16

export interface PublicHttpsRequestOptions {
	readonly endpoint: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: string | Uint8Array
	readonly signal: AbortSignal
	readonly maxResponseBytes: number
}

function policyError(message: string, code: string): Error & {readonly retryable: false; readonly code: string} {
	return Object.assign(new Error(message), {retryable: false as const, code})
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<readonly {
	readonly address: string
	readonly family: 4 | 6
}[]> {
	const resolution = lookup(hostname, {all: true, verbatim: true})
	const aborted = new Promise<never>((_resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return }
		signal.addEventListener('abort', () => reject(signal.reason), {once: true})
	})
	const addresses = await Promise.race([resolution, aborted])
	if (addresses.length > MAX_DNS_ANSWERS) throw policyError(
		'Public HTTPS endpoint returned too many DNS answers', 'PUBLIC_HTTPS_DNS_ANSWER_LIMIT'
	)
	if (addresses.length === 0 || addresses.some(({address, family}) =>
		(family !== 4 && family !== 6) || !isPublicNetworkAddress(address))) {
		throw policyError('Public HTTPS endpoint resolved to a non-public network address', 'PUBLIC_HTTPS_NON_PUBLIC_ENDPOINT')
	}
	const unique = [...new Map(addresses.map(({address, family}) => [
		`${family}:${address}`, {address, family: family as 4 | 6}
	])).values()]
	if (unique.length > MAX_PUBLIC_ADDRESSES) throw policyError(
		'Public HTTPS endpoint resolved to too many addresses', 'PUBLIC_HTTPS_DNS_ANSWER_LIMIT'
	)
	return unique
}

function requestAddress(
	endpoint: URL,
	address: {readonly address: string; readonly family: 4 | 6},
	options: PublicHttpsRequestOptions
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest({
			protocol: 'https:', hostname: address.address, family: address.family,
			port: endpoint.port || undefined, path: `${endpoint.pathname}${endpoint.search}`,
			method: 'POST',
			headers: {
				...options.headers,
				Host: endpoint.host,
				'Content-Length': typeof options.body === 'string'
					? Buffer.byteLength(options.body, 'utf8') : options.body.byteLength
			},
			...(isIP(endpoint.hostname.replaceAll('[', '').replaceAll(']', '')) === 0
				? {servername: endpoint.hostname} : {}),
			signal: options.signal
		}, (response) => {
			const chunks: Buffer[] = []
			let bytes = 0
			response.once('error', reject)
			response.on('data', (chunk: Buffer | string) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
				bytes += buffer.byteLength
				if (bytes > options.maxResponseBytes) {
					response.destroy(policyError('Public HTTPS response exceeds the maximum size', 'PUBLIC_HTTPS_RESPONSE_TOO_LARGE'))
					return
				}
				chunks.push(buffer)
			})
			response.once('end', () => {
				const responseHeaders = new Headers()
				for (const [key, raw] of Object.entries(response.headers)) {
					const value = Array.isArray(raw) ? raw.join(', ') : raw
					if (value !== undefined) responseHeaders.set(key, String(value))
				}
				const status = response.statusCode ?? 0
				if (status < 200 || status > 599) {
					reject(policyError('Public HTTPS endpoint returned an invalid status', 'PUBLIC_HTTPS_INVALID_STATUS'))
					return
				}
				resolve(new Response(Buffer.concat(chunks), {
					status, statusText: response.statusMessage ?? '', headers: responseHeaders
				}))
			})
		})
		request.once('error', reject)
		request.end(options.body)
	})
}

/** Resolve once, validate every answer, then connect directly to a validated IP. */
export async function sendPublicHttps(options: PublicHttpsRequestOptions): Promise<Response> {
	if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) {
		throw new TypeError('Public HTTPS maxResponseBytes must be a positive safe integer')
	}
	const endpoint = new URL(options.endpoint)
	if (endpoint.protocol !== 'https:') throw policyError(
		'Public HTTPS endpoint must use HTTPS', 'PUBLIC_HTTPS_INSECURE_ENDPOINT'
	)
	const hostname = endpoint.hostname.replaceAll('[', '').replaceAll(']', '')
	const addresses = await resolvePublicAddresses(hostname, options.signal)
	let lastError: unknown
	for (const address of addresses) {
		try { return await requestAddress(endpoint, address, options) } catch(error) {
			if (options.signal.aborted) throw error
			const retryable = error && typeof error === 'object'
				? Object.getOwnPropertyDescriptor(error, 'retryable')?.value : undefined
			if (retryable === false) throw error
			lastError = error
		}
	}
	throw lastError ?? new Error('Public HTTPS endpoint has no reachable address')
}

/** Adapt a fixed public endpoint to Fetch so higher-level protocol clients can reuse it. */
export function createPublicHttpsTransport(endpoint: string, maxResponseBytes: number): typeof fetch {
	return (async(_input, init) => await sendPublicHttps({
		endpoint,
		headers: init?.headers as Record<string, string>,
		body: init?.body as string | Uint8Array,
		signal: init?.signal as AbortSignal,
		maxResponseBytes
	})) as typeof fetch
}
