/**
 * @file OTLP exporter implementation.
 * Sends metrics via OpenTelemetry Protocol HTTP with exemplar support.
 */

import type {Logging} from '@ooopsstudio/core/ports/logging'
import {validateHeaders, validateUrl} from '@ooopsstudio/core/utils/validation'

import {
	MAX_METRICS_TIMER_MS,
	METRICS_MAX_EXPORT_SNAPSHOT_BYTES,
	OTLP_MAX_CONCURRENT_EXPORTS,
	OTLP_EXPORTER_TIMEOUT_MS,
	OTLP_MAX_ENDPOINT_LENGTH
} from '../../constants'
import type {MetricExporterPort, MetricExportResult} from '../../types/exporter'
import type {MetricRecord} from '../../types/metric-record'
import {getLogger, isSafeLogger} from '../../utils/logger'
import {snapshotMetricBatch} from '../../utils/metric-record-snapshot'

import {convertToOtlp} from './otlp-conversion'
import {isSensitiveOtlpHeaderName, sendOtlpHttp, type OtlpHttpResult} from './otlp-http'

const MAX_OTLP_HEADER_COUNT = 64
const MAX_OTLP_HEADER_KEY_LENGTH = 128
const MAX_OTLP_HEADER_VALUE_LENGTH = 8_192
const MAX_OTLP_HEADER_BYTES = 32_768
const OTLP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const RESERVED_OTLP_HEADERS = new Set([
	'connection', 'content-encoding', 'content-length', 'content-type',
	'host', 'transfer-encoding'
])
const RESOLVED_VOID_PROMISE = Promise.resolve()

function snapshotStringRecord(value: unknown, label: string): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must expose stable data fields`)
	}
	let prototype: object | null
	let descriptors: PropertyDescriptorMap
	try {
		prototype = Object.getPrototypeOf(value)
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbols')
	} catch {
		throw new Error(`${label} must expose stable data fields`)
	}
	if (prototype !== Object.prototype) throw new Error(`${label} must expose stable data fields`)
	const entries: Array<readonly [string, string]> = []
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
			throw new Error(`${label} must expose stable data fields`)
		}
		if (key.length > MAX_OTLP_HEADER_KEY_LENGTH) {
			throw new Error(`${label} must contain bounded string data fields`)
		}
		if (descriptor.value.length > MAX_OTLP_HEADER_VALUE_LENGTH) {
			throw new Error(`${label} header value is invalid`)
		}
		entries.push([key, descriptor.value])
	}
	return Object.fromEntries(entries)
}

function snapshotStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must contain non-empty strings`)
	let descriptors: PropertyDescriptorMap
	try {
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('symbols')
	} catch {
		throw new Error(`${label} must contain non-empty strings`)
	}
	const length = descriptors.length && 'value' in descriptors.length
		? descriptors.length.value : undefined
	if (!Number.isSafeInteger(length) || length < 0 || length > 1_000) {
		throw new Error(`${label} must contain non-empty strings`)
	}
	const result: string[] = []
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)]
		if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
			|| typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
			throw new Error(`${label} must contain non-empty strings`)
		}
		result.push(descriptor.value)
	}
	return result
}

function validateOtlpHeaders(headers: Record<string, string>): void {
	const entries = Object.entries(headers)
	if (entries.length > MAX_OTLP_HEADER_COUNT) throw new Error('OTLP exporter has too many headers')
	const normalized = new Set<string>()
	let totalBytes = 0
	for (const [key, value] of entries) {
		if (key.length > MAX_OTLP_HEADER_KEY_LENGTH || !OTLP_HEADER_NAME.test(key)) {
			throw new Error('OTLP exporter header name is invalid')
		}
		const lowerKey = key.toLowerCase()
		if (RESERVED_OTLP_HEADERS.has(lowerKey)) {
			throw new Error(`OTLP exporter header "${lowerKey}" is managed by the exporter`)
		}
		if (normalized.has(lowerKey)) throw new Error('OTLP exporter headers must be unique ignoring case')
		if (value.length > MAX_OTLP_HEADER_VALUE_LENGTH || /[\r\n]/u.test(value)) {
			throw new Error(`OTLP exporter header value for "${lowerKey}" is invalid`)
		}
		normalized.add(lowerKey)
		totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value)
		if (totalBytes > MAX_OTLP_HEADER_BYTES) throw new Error('OTLP exporter headers are too large')
	}
}

/**
 * Options for OTLP exporter
 */
export interface OtlpExporterOptions {
	readonly endpoint: string
	readonly headers?: Record<string, string>
	readonly timeout?: number
	readonly protocol?: 'http'
	readonly allowedHeaders?: string[] // Headers allowed in error logs (default: empty, all headers redacted)
	readonly enableGzip?: boolean // Enable gzip compression for large batches (default: false)
	readonly gzipThresholdBytes?: number // Minimum batch size to trigger gzip (default: 1KB)
	/** Require every resolved endpoint address to be public. Used by production presets. */
	readonly requirePublicEndpoint?: boolean
	readonly onError?: (error: unknown, context?: Record<string, string>) => void // Error callback
	readonly logger?: Logging
}

interface _HistogramGroup {
	baseName: string
	labels: Record<string, string>
	timestamp: number
	sum?: number
	count?: number
	buckets: Array<{le: number; count: number; exemplar?: MetricRecord['exemplar']}>
	overflowCount?: number
	overflowExemplar?: MetricRecord['exemplar']
	metadata?: MetricRecord['metadata']
}

interface _SummaryGroup {
	baseName: string
	labels: Record<string, string>
	timestamp: number
	quantileValues: Array<{quantile: number; value: number}>
	sum?: number
	count?: number
	metadata?: MetricRecord['metadata']
}

/**
 * OTLP exporter
 * Sends metrics via OpenTelemetry Protocol
 */
export class OtlpExporter implements MetricExporterPort {

	private readonly endpoint: string
	private readonly headers: Record<string, string>
	private readonly timeout: number
	private readonly allowedHeaders: Set<string>
	private readonly enableGzip: boolean
	private readonly gzipThresholdBytes: number
	private readonly requirePublicEndpoint: boolean
	private readonly onError: ((error: unknown, context?: Record<string, string>) => void) | undefined
	private readonly logger: Logging
	private activeExports = 0
	private closed = false
	private activeDrainPromise: Promise<void> | undefined
	private resolveActiveDrain: (() => void) | undefined

	constructor(options: OtlpExporterOptions) {
		if (!options || typeof options !== 'object') throw new Error('OTLP exporter options must be an object')
		const optionDescriptors = Object.getOwnPropertyDescriptors(options)
		if (Object.getPrototypeOf(options) !== Object.prototype
			|| Object.getOwnPropertySymbols(options).length > 0
			|| Object.entries(optionDescriptors).some(([key, descriptor]) =>
				!['endpoint', 'headers', 'timeout', 'protocol', 'allowedHeaders', 'enableGzip', 'gzipThresholdBytes', 'requirePublicEndpoint', 'onError', 'logger'].includes(key)
				|| !descriptor.enumerable || !('value' in descriptor))) {
			throw new Error('OTLP exporter options must expose stable known data fields')
		}
		const stable = Object.fromEntries(
			Object.entries(optionDescriptors).map(([key, descriptor]) => [key, descriptor.value])
		) as unknown as OtlpExporterOptions
		const {
			endpoint,
			headers = {},
			timeout = OTLP_EXPORTER_TIMEOUT_MS,
			protocol = 'http',
			allowedHeaders = [],
			enableGzip = false,
			gzipThresholdBytes = 1024, // 1KB threshold
			requirePublicEndpoint = false,
			onError,
			logger
		} = stable

		// Validate inputs
		if (typeof endpoint !== 'string' || endpoint.length > OTLP_MAX_ENDPOINT_LENGTH) {
			throw new Error(`OTLP endpoint must be a string no longer than ${OTLP_MAX_ENDPOINT_LENGTH} characters`)
		}
		validateUrl(endpoint, 'OTLP endpoint')
		const parsedEndpoint = new URL(endpoint)
		const endpointProtocol = parsedEndpoint.protocol
		if (endpointProtocol !== 'http:' && endpointProtocol !== 'https:') {
			throw new Error('OTLP endpoint must use http or https')
		}
		if (parsedEndpoint.username || parsedEndpoint.password) {
			throw new Error('OTLP endpoint must not contain embedded credentials')
		}
		if (parsedEndpoint.search || parsedEndpoint.hash) {
			throw new Error('OTLP endpoint must not contain query parameters or fragments')
		}
		const stableHeaders = snapshotStringRecord(headers, 'OTLP exporter headers')
		validateHeaders(stableHeaders)
		validateOtlpHeaders(stableHeaders)
		if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_METRICS_TIMER_MS) {
			throw new Error(`OTLP exporter timeout must be positive and finite, got ${timeout}ms`)
		}
		if (!Number.isSafeInteger(gzipThresholdBytes) || gzipThresholdBytes <= 0
			|| gzipThresholdBytes > METRICS_MAX_EXPORT_SNAPSHOT_BYTES) {
			throw new Error(`OTLP exporter gzipThresholdBytes must be between 1 and ${METRICS_MAX_EXPORT_SNAPSHOT_BYTES}`)
		}
		const protocolValue: unknown = protocol
		if (protocolValue !== 'http') {
			throw new Error(`OTLP exporter protocol "${typeof protocolValue === 'string' ? protocolValue.slice(0, 64) : typeof protocolValue}" is not supported; use protocol "http"`)
		}
		if (typeof enableGzip !== 'boolean') {
			throw new Error(`OTLP exporter enableGzip must be a boolean, got ${typeof enableGzip}`)
		}
		if (typeof requirePublicEndpoint !== 'boolean') {
			throw new Error(`OTLP exporter requirePublicEndpoint must be a boolean, got ${typeof requirePublicEndpoint}`)
		}
		const stableAllowedHeaders = snapshotStringArray(allowedHeaders, 'OTLP exporter allowedHeaders')
		if (stableAllowedHeaders.length > MAX_OTLP_HEADER_COUNT
			|| stableAllowedHeaders.some((header) => header.length > MAX_OTLP_HEADER_KEY_LENGTH
				|| !OTLP_HEADER_NAME.test(header) || isSensitiveOtlpHeaderName(header))) {
			throw new Error('OTLP exporter allowedHeaders contains an invalid header name')
		}
		if (onError !== undefined && typeof onError !== 'function') {
			throw new Error('OTLP exporter onError must be a function')
		}

		this.endpoint = endpoint
		this.headers = stableHeaders
		this.timeout = timeout
		this.allowedHeaders = new Set(stableAllowedHeaders.map((header) => header.toLowerCase()))
		this.enableGzip = enableGzip
		this.gzipThresholdBytes = gzipThresholdBytes
		this.requirePublicEndpoint = requirePublicEndpoint
		this.onError = onError
		// Get logger with fallback (never use metrics port from within metrics service)
		this.logger = isSafeLogger(logger) ? getLogger(logger) : getLogger(undefined)
	}

	/**
	 * Scrub sensitive headers from error messages
	 */
	private scrubHeaders(headers: Record<string, string>): Record<string, string> {

		const scrubbed: Record<string, string> = {}
		for (const [key, value] of Object.entries(headers)) {
			const lowerKey = key.toLowerCase()
			// Always redact Authorization header
			if (isSensitiveOtlpHeaderName(lowerKey)) {
				scrubbed[key] = '[REDACTED]'
			} else if (this.allowedHeaders.has(lowerKey)) {
				// Allow explicitly allowed headers
				scrubbed[key] = value
			} else {
				// Redact all other headers by default
				scrubbed[key] = '[REDACTED]'
			}
		}
		return scrubbed
	}

	private reportError(error: unknown, context?: Record<string, string>): void {
		try {
			this.onError?.(error, context)
		} catch {
			// Diagnostics are deliberately isolated from OTLP delivery.
		}
	}

	async export(batch: ReadonlyArray<MetricRecord>): Promise<void | MetricExportResult> {
		if (this.closed) {
			throw Object.assign(new Error('OTLP exporter is shut down'), {
				code: 'otlp_exporter_closed', retryable: false
			})
		}
		if (this.activeExports >= OTLP_MAX_CONCURRENT_EXPORTS) {
			throw Object.assign(new Error(
				`OTLP exporter concurrent export limit of ${OTLP_MAX_CONCURRENT_EXPORTS} exceeded`
			), {code: 'otlp_concurrency_limit', retryable: true})
		}
		this.activeExports += 1
		try {
			const stableBatch = snapshotMetricBatch(batch)
			if (stableBatch.length === 0) return
			// Convert to OTLP MetricData format
			const metricData = this.convertToOtlp(stableBatch)

			const result = await this.sendHttp(metricData)
			if (result.partialSuccess) {
				const {rejectedDataPoints} = result.partialSuccess
				const partialError = Object.assign(
					new Error(`OTLP collector rejected ${rejectedDataPoints} metric data points`),
					{code: 'otlp_partial_success', retryable: false, rejectedDataPoints}
				)
				this.reportError(partialError, {
					operation: 'export', exporter: 'otlp', rejectedDataPoints
				})
				this.logger.warn('metrics.otlp_partial_success', {
					rejectedDataPoints,
					error: 'metrics_otlp_partial_success'
				})
			}
		} catch(error) {
			const scrubbedHeaders = this.scrubHeaders(this.headers)
			if (this.onError) {
				this.reportError(new Error('metrics_otlp_export_failed'), {
					operation: 'export', exporter: 'otlp', error: 'metrics_otlp_export_failed'
				})
			}
			this.logger.error('metrics.otlp_exporter_error', {error: 'metrics_otlp_export_failed', headers: scrubbedHeaders})
			throw error
		} finally {
			this.activeExports = Math.max(0, this.activeExports - 1)
			if (this.activeExports === 0) {
				const resolve = this.resolveActiveDrain
				this.activeDrainPromise = undefined
				this.resolveActiveDrain = undefined
				resolve?.()
			}
		}
	}

	/**
	 * Convert metric records to OTLP format
	 */
	private convertToOtlp(batch: ReadonlyArray<MetricRecord>): unknown {
		return convertToOtlp(batch)
	}

	/**
	 * Send via HTTP
	 */
	private async sendHttp(data: unknown): Promise<OtlpHttpResult> {
		return sendOtlpHttp(data, {
			endpoint: this.endpoint, headers: this.headers, timeout: this.timeout, allowedHeaders: this.allowedHeaders,
			enableGzip: this.enableGzip, gzipThresholdBytes: this.gzipThresholdBytes,
			requirePublicEndpoint: this.requirePublicEndpoint
		})
	}

	flush(): Promise<void> {
		return this.waitForActiveExports()
	}

	shutdown(): Promise<void> {
		this.closed = true
		return this.waitForActiveExports()
	}

	private waitForActiveExports(): Promise<void> {
		if (this.activeExports === 0) return RESOLVED_VOID_PROMISE
		if (!this.activeDrainPromise) {
			this.activeDrainPromise = new Promise<void>((resolve) => {
				this.resolveActiveDrain = resolve
			})
		}
		return this.activeDrainPromise
	}
}

/**
 * Create an OTLP exporter
 */
export function createOtlpExporter(options: OtlpExporterOptions): OtlpExporter {
	return new OtlpExporter(options)
}
