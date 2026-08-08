import {lookup} from 'node:dns/promises'
import {request as httpsRequest} from 'node:https'
import {isIP} from 'node:net'

import {isPublicNetworkAddress} from '../../utils/public-network-address'

export interface PublicOtlpHttpResponse {
	readonly status: number
	readonly statusText: string
	readonly retryAfter: string | null
	readonly body: string
}

const MAX_OTLP_RESPONSE_BYTES = 64 * 1024
const MAX_OTLP_PUBLIC_ADDRESSES = 16
const MAX_OTLP_DNS_ANSWERS = 64

function nonPublicEndpointError(): Error & {readonly retryable: false; readonly code: string} {
	return Object.assign(
		new Error('Production OTLP endpoint resolved to a non-public network address'),
		{retryable: false as const, code: 'otlp_non_public_endpoint'}
	)
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<readonly {
	readonly address: string
	readonly family: 4 | 6
}[]> {
	const resolved = lookup(hostname, {all: true, verbatim: true})
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		signal.addEventListener('abort', () => reject(signal.reason), {once: true})
	})
	const addresses = await Promise.race([resolved, aborted])
	if (addresses.length > MAX_OTLP_DNS_ANSWERS) {
		throw Object.assign(new Error('Production OTLP endpoint returned too many DNS answers'), {
			retryable: false,
			code: 'otlp_dns_answer_limit'
		})
	}
	if (addresses.length === 0 || addresses.some(({address, family}) =>
		(family !== 4 && family !== 6) || !isPublicNetworkAddress(address))) {
		throw nonPublicEndpointError()
	}
	const unique = [...new Map(addresses.map(({address, family}) => [
		`${family}:${address}`,
		{address, family: family as 4 | 6}
	])).values()]
	if (unique.length > MAX_OTLP_PUBLIC_ADDRESSES) {
		throw Object.assign(new Error('Production OTLP endpoint resolved to too many addresses'), {
			retryable: false,
			code: 'otlp_dns_answer_limit'
		})
	}
	return unique
}

function requestAddress(
	endpoint: URL,
	address: {readonly address: string; readonly family: 4 | 6},
	headers: Record<string, string>,
	body: string | Uint8Array,
	signal: AbortSignal
): Promise<PublicOtlpHttpResponse> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest({
			protocol: 'https:',
			hostname: address.address,
			family: address.family,
			port: endpoint.port || undefined,
			path: `${endpoint.pathname}${endpoint.search}`,
			method: 'POST',
			headers: {
				...headers,
				Host: endpoint.host,
				'Content-Length': typeof body === 'string'
					? Buffer.byteLength(body, 'utf8')
					: body.byteLength
			},
			...(isIP(endpoint.hostname.replaceAll('[', '').replaceAll(']', '')) === 0
				? {servername: endpoint.hostname} : {}),
			signal
		}, (response) => {
			const chunks: Buffer[] = []
			let bytes = 0
			response.once('error', reject)
			response.on('data', (chunk: Buffer | string) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
				bytes += buffer.byteLength
				if (bytes > MAX_OTLP_RESPONSE_BYTES) {
					response.destroy(Object.assign(
						new Error('OTLP response body exceeds the 65536-byte limit'),
						{retryable: false, code: 'otlp_response_too_large'}
					))
					return
				}
				chunks.push(buffer)
			})
			response.once('end', () => {
				const retryAfter = response.headers['retry-after']
				resolve({
					status: response.statusCode ?? 0,
					statusText: response.statusMessage ?? '',
					retryAfter: Array.isArray(retryAfter) ? (retryAfter[0] ?? null) : retryAfter ?? null,
					body: Buffer.concat(chunks).toString('utf8')
				})
			})
		})
		request.once('error', reject)
		request.end(body)
	})
}

/** Resolve once, validate every answer, then connect to the validated IP. */
export async function sendPublicOtlpHttps(
	endpointValue: string,
	headers: Record<string, string>,
	body: string | Uint8Array,
	signal: AbortSignal
): Promise<PublicOtlpHttpResponse> {
	const endpoint = new URL(endpointValue)
	if (endpoint.protocol !== 'https:') {
		throw Object.assign(new Error('Production OTLP endpoint must use HTTPS'), {
			retryable: false,
			code: 'otlp_insecure_endpoint'
		})
	}
	const hostname = endpoint.hostname.replaceAll('[', '').replaceAll(']', '')
	const addresses = await resolvePublicAddresses(hostname, signal)
	let lastError: unknown
	for (const address of addresses) {
		try {
			return await requestAddress(endpoint, address, headers, body, signal)
		} catch(error) {
			if (signal.aborted) throw error
			const retryable = error && typeof error === 'object'
				? Object.getOwnPropertyDescriptor(error, 'retryable')?.value : undefined
			if (retryable === false) throw error
			lastError = error
		}
	}
	throw lastError ?? new Error('Production OTLP endpoint has no reachable public address')
}
