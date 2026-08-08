import {isIP} from 'node:net'

import type {Logging} from '@ooopsstudio/core/ports/logging'

import {PROMETHEUS_HTTP_HOST, PROMETHEUS_HTTP_PORT} from '../constants'
import {PrometheusHttpServer} from '../http/prometheus-http-server'
import {validateHost} from '../utils/config-validation'
import {getLogger, isSafeLogger} from '../utils/logger'
import {capturePrometheusScrapeCapability} from '../utils/prometheus-scrape-capability'

import type {PrometheusScrapeSource} from './prometheus'

export interface PrometheusHttpAdapterOptions {
	readonly host?: string
	readonly port?: number
	readonly exposure?: 'loopback' | 'network'
	readonly logger?: Logging
	readonly onError?: (error: unknown, context: Record<string, string>) => void
}

function snapshotAdapterOptions(value: PrometheusHttpAdapterOptions): PrometheusHttpAdapterOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Prometheus HTTP server options must be an object')
	}
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	let symbols: symbol[]
	try {
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value)
		symbols = Object.getOwnPropertySymbols(value)
	} catch {
		throw new Error('Prometheus HTTP server options must expose stable known data fields')
	}
	if ((prototype !== Object.prototype && prototype !== null) || symbols.length > 0
		|| Object.entries(descriptors).some(([key, descriptor]) =>
			!['host', 'port', 'exposure', 'logger', 'onError'].includes(key)
			|| !descriptor.enumerable || !('value' in descriptor))) {
		throw new Error('Prometheus HTTP server options must expose stable known data fields')
	}
	return Object.freeze(Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
	)) as PrometheusHttpAdapterOptions
}

/**
 * Create an optional Node HTTP adapter for a Prometheus scrape source.
 * App-mounted presets intentionally do not import this module.
 */
export function createPrometheusHttpServer(
	source: PrometheusScrapeSource,
	options: PrometheusHttpAdapterOptions = {}
): PrometheusHttpServer {
	if (!source || typeof source !== 'object') {
		throw new Error('Prometheus HTTP server requires a scrape source')
	}
	const getScrape = capturePrometheusScrapeCapability(source)
	if (!getScrape) throw new Error('Prometheus HTTP server requires a scrape source')
	const stableOptions = snapshotAdapterOptions(options)
	if (stableOptions.onError !== undefined && typeof stableOptions.onError !== 'function') {
		throw new Error('Prometheus HTTP server onError must be a function')
	}
	const exposure = stableOptions.exposure ?? 'loopback'
	if (exposure !== 'loopback' && exposure !== 'network') {
		throw new Error('Prometheus HTTP server exposure must be loopback or network')
	}
	const host = stableOptions.host ?? (exposure === 'network' ? '0.0.0.0' : PROMETHEUS_HTTP_HOST)
	const port = stableOptions.port ?? PROMETHEUS_HTTP_PORT
	if (typeof host !== 'string') throw new Error('Prometheus HTTP server host must be a string')
	validateHost(host, exposure === 'network')
	const normalizedHost = host.replaceAll('[', '').replaceAll(']', '').toLowerCase()
	const loopback = normalizedHost === 'localhost' || normalizedHost === '::1'
		|| (isIP(normalizedHost) === 4 && normalizedHost.split('.')[0] === '127')
	if (exposure === 'loopback' && !loopback) {
		throw new Error('Prometheus HTTP loopback exposure requires a loopback host')
	}
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error('Prometheus HTTP server port must be between 0 and 65535')
	}
	return new PrometheusHttpServer({
		host,
		port,
		logger: isSafeLogger(stableOptions.logger) ? getLogger(stableOptions.logger) : getLogger(undefined),
		onError: stableOptions.onError ?? (() => undefined),
		getScrape
	})
}

export {PrometheusHttpServer} from '../http/prometheus-http-server'
export type {PrometheusScrape, PrometheusScrapeSource} from './prometheus'
