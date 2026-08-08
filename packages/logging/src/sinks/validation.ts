import {readLoggingDataProperty} from '../utils/capabilities'
import {assertPositiveTimerMs} from '../utils/validation'

import type {LoggingSinkConfig} from './types'

const MAX_CONFIG_RECORD_ENTRIES = 100
const MAX_HEADER_VALUE_LENGTH = 8_192
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u

function snapshotStringRecord(value: unknown, name: string): Readonly<Record<string, string>> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${name} must be a plain object`)
	}
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.length > MAX_CONFIG_RECORD_ENTRIES || keys.some((key) => typeof key !== 'string')) throw new TypeError()
		const snapshot = Object.create(null) as Record<string, string>
		for (const key of keys as string[]) {
			const descriptor = descriptors[key]
			if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new TypeError()
			if (!key || key.length > 128 || /[\r\n]/u.test(descriptor.value) || descriptor.value.length > MAX_HEADER_VALUE_LENGTH) {
				throw new TypeError()
			}
			snapshot[key] = descriptor.value
		}
		return snapshot
	} catch {
		throw new TypeError(`${name} must contain bounded string data properties only`)
	}
}

export function snapshotLoggingSinkConfig(value: unknown): LoggingSinkConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('createLoggingSink: configuration must be an object')
	}
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some((key) => typeof key !== 'string')) throw new TypeError()
		const provider = descriptors.provider?.value
		if (provider !== 'http' && provider !== 'loki') {
			throw new Error(`createLoggingSink: unsupported provider ${typeof provider === 'string' ? provider : 'invalid'}`)
		}
		const allowed = new Set(provider === 'loki'
			? ['provider', 'url', 'headers', 'defaultLabels', 'requestTimeoutMs', 'keepalive']
			: ['provider', 'url', 'headers', 'requestTimeoutMs', 'keepalive'])
		if (keys.some((key) => !allowed.has(key as string)) || Object.values(descriptors).some(
			(descriptor) => !descriptor.enumerable || !('value' in descriptor)
		)) throw new TypeError()
		const url = descriptors.url?.value
		if (typeof url !== 'string') throw new TypeError(`createLoggingSink: ${provider} url must be a string`)
		const headers = descriptors.headers?.value === undefined
			? undefined : snapshotStringRecord(descriptors.headers.value, 'logging headers')
		const defaultLabels = provider === 'loki' && descriptors.defaultLabels?.value !== undefined
			? snapshotStringRecord(descriptors.defaultLabels.value, 'logging.loki.defaultLabels') : undefined
		return {
			provider, url,
			...(headers ? {headers} : {}),
			...(defaultLabels ? {defaultLabels} : {}),
			...(descriptors.requestTimeoutMs?.value !== undefined ? {requestTimeoutMs: descriptors.requestTimeoutMs.value as number} : {}),
			...(descriptors.keepalive?.value !== undefined ? {keepalive: descriptors.keepalive.value as boolean} : {})
		} as LoggingSinkConfig
	} catch(error) {
		const message = readLoggingDataProperty<unknown>(error, 'message')
		if (typeof message === 'string'
			&& (message.startsWith('createLoggingSink:') || message.startsWith('logging'))) throw error
		throw new TypeError('createLoggingSink: configuration contains invalid or unexpected fields')
	}
}

export function validateLoggingSinkConfig(config: Readonly<LoggingSinkConfig>): void {
	let parsed: URL
	try { parsed = new URL(config.url) } catch {
		throw new Error(`logging.${config.provider}.url must be a valid URL`)
	}
	const protocol = parsed.protocol
	if (protocol !== 'http:' && protocol !== 'https:') {
		throw new Error(`logging.${config.provider}.url must use http or https, got: ${protocol}`)
	}
	if (parsed.username || parsed.password) {
		throw new Error(`logging.${config.provider}.url must not contain embedded credentials`)
	}
	if (config.headers) {
		for (const [key, value] of Object.entries(config.headers)) {
			if (!HEADER_NAME.test(key) || /[\r\n]/u.test(value)) {
				throw new Error('logging headers contain an invalid name or value')
			}
			if (key.toLowerCase() === 'content-type') {
				throw new Error('logging headers must not override content-type')
			}
		}
	}
	if (config.requestTimeoutMs !== undefined) {
		assertPositiveTimerMs(config.requestTimeoutMs, `logging.${config.provider}.requestTimeoutMs`)
	}
	if (config.keepalive !== undefined && typeof config.keepalive !== 'boolean') {
		throw new Error(`logging.${config.provider}.keepalive must be a boolean`)
	}
	if (config.provider === 'loki' && config.defaultLabels) {
		for (const [key, value] of Object.entries(config.defaultLabels)) {
			if (!key || typeof value !== 'string') {
				throw new Error('logging.loki.defaultLabels must contain non-empty keys and string values')
			}
		}
	}
}
