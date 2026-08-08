import type {HttpPerfMetadata} from '@ooopsstudio/core/contracts/performance'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'

import {capturePerformanceMethod, ignorePromiseRejection} from './performance-port-method'
import {isRuntimeProxy} from './runtime-object'

let activeReflections = 0
let reflectionCalls = 0
const safelyReflect = <T>(callback: () => T): T | undefined => {
	if (++reflectionCalls > 100) return
	activeReflections++
	try { return callback() } catch { /* fail open */ } finally {
		if (!--activeReflections) reflectionCalls = 0
	}
}

const safeDimension = (value: unknown): string | undefined => {
	return typeof value === 'string' && /^[a-z_.-]{1,128}$/i.test(value) ? value : undefined
}

export async function measureAsyncOperation<T>(
	performance: PerformancePort | undefined,
	name: string,
	fn: () => Promise<T>,
	labels?: Record<string, string>
): Promise<T> {
	const measureAsync = safelyReflect(() => capturePerformanceMethod(
		performance, 'measureAsync'
	) as NonNullable<PerformancePort['measureAsync']> | undefined)
	let operationPromise: Promise<T> | undefined
	const invokeOnce = (): Promise<T> => {
		operationPromise ??= Promise.resolve().then(fn)
		return operationPromise
	}
	if (measureAsync) {
		try {
			const instrumentation = measureAsync(name, invokeOnce, safelyReflect(() => snapshotLabels(labels)))
			ignorePromiseRejection(instrumentation)
			await 0
		} catch {
			// Measurement is observational; operation completion remains authoritative.
		}
	}
	return invokeOnce()
}

export function recordPerformanceMetric(
	performance: PerformancePort | undefined,
	name: string,
	value: number,
	labels?: Record<string, string>
): void {
	const record = safelyReflect(() => capturePerformanceMethod(
		performance, 'record'
	) as NonNullable<PerformancePort['record']> | undefined)
	if (!record) return
	try {
		ignorePromiseRejection(record(name, value, safelyReflect(() => snapshotLabels(labels))))
	} catch {
		// Recording is observational and must not escape into application code.
	}
}

export interface FetchLikeRequest {
	method?: string
	url?: string
	headers?: {
		get?(name: string): string | null
	} | Record<string, string | undefined>
}

export interface FetchLikeResponse {
	status: number
	headers?: {
		get?(name: string): string | null
	} | Record<string, string | undefined>
}

export interface InstrumentFetchHandlerOptions<TRequest extends FetchLikeRequest> {
	performance?: PerformancePort
	name?: string
	route: string
	hostKind?: string
	runtime?: string
	labels?: Record<string, string>
	getRequestSize?: (request: TRequest) => number | undefined
	getResponseSize?: (response: FetchLikeResponse) => number | undefined
}

const FETCH_OPTION_FIELDS = 'performance name route hostKind runtime labels getRequestSize getResponseSize'.split(' ')

const snapshotLabels = (value: unknown): Record<string, string> | undefined => {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value)) return undefined
	const labels: Record<string, string> = {}
	const keys = Reflect.ownKeys(value)
	if (keys[20]) return
	for (const key of keys) {
		if (typeof key !== 'string') return undefined
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (key[64] || !safeDimension(key) || /access|api.?key|auth|bear|cook|cred|id$|jwt|^key$|mail|oauth|pass|priv|secr|sess|token/i.test(key)
			|| typeof descriptor?.value !== 'string') continue
		labels[key] = descriptor.value.slice(0, 256)
	}
	return labels
}

const snapshotFetchOptions = <TRequest extends FetchLikeRequest>(
	value: unknown
): InstrumentFetchHandlerOptions<TRequest> | undefined => {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value)) return undefined
	const snapshot: Record<string, unknown> = {}
	return safelyReflect(() => {
		for (const key of FETCH_OPTION_FIELDS) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor) continue
			if (!('value' in descriptor)) return undefined
			snapshot[key] = key === 'labels' ? snapshotLabels(descriptor.value) : descriptor.value
		}
		return typeof snapshot.route === 'string' ? snapshot as unknown as InstrumentFetchHandlerOptions<TRequest> : undefined
	})
}

const hasSafePrototype = (value: unknown): boolean => {
	let owner = value as object | null
	for (let depth = 32; owner && depth-- && !isRuntimeProxy(owner);) {
		owner = Object.getPrototypeOf(owner) as object | null
	}
	return !owner
}

const readFetchProperty = (value: unknown, key: 'method' | 'status' | 'headers'): unknown => {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value)) return undefined
	return safelyReflect(() => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (descriptor) return 'value' in descriptor ? descriptor.value : undefined
		const constructors = [
			key === 'status' ? globalThis.Response : globalThis.Request,
			key === 'headers' ? globalThis.Response : undefined
		]
		for (const constructor of constructors) {
			const getter = constructor && Object.getOwnPropertyDescriptor(constructor.prototype, key)?.get
			if (typeof getter === 'function') {
				try { return Reflect.apply(getter, value, []) } catch { /* try the other native brand */ }
			}
		}
		return undefined
	})
}

const parseContentLength = (value: string | undefined): number | undefined =>
	/^\d{1,15}$/.test(value as string) ? +(value as string) : undefined

const getHeader = (
	headers: FetchLikeRequest['headers'] | FetchLikeResponse['headers'],
	name: string
): string | undefined => {
	if (!headers || isRuntimeProxy(headers)) return undefined
	return safelyReflect(() => {
		const get = hasSafePrototype(headers)
			? capturePerformanceMethod(headers as never, 'get' as never) as ((name: string) => unknown) | undefined
			: undefined
		if (get) {
			const result = get(name)
			ignorePromiseRejection(result)
			return typeof result === 'string' ? result : undefined
		}
		for (const key of [name, 'Content-Length']) {
			const descriptor = Object.getOwnPropertyDescriptor(headers, key)
			if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') return descriptor.value
		}
		return undefined
	})
}

const safelyReadSize = <T>(reader: ((value: T) => number | undefined) | undefined, value: T): number | undefined => {
	if (!reader) return undefined
	const size = safelyReflect(() => reader(value))
	ignorePromiseRejection(size)
	return Number.isSafeInteger(size) && (size as number) >= 0 ? size : undefined
}

export function instrumentFetchHandler<TRequest extends FetchLikeRequest, TResponse extends FetchLikeResponse>(
	handler: (request: TRequest) => Promise<TResponse>,
	options: InstrumentFetchHandlerOptions<TRequest>
): (request: TRequest) => Promise<TResponse> {
	const configured = snapshotFetchOptions<TRequest>(options)
	const rawRoute = configured?.route
	const configuredRoute = /^\/(?!\/)[a-z_./:[\]-]{0,255}$/i.test(rawRoute as string)
		? rawRoute! : '/redacted'
	const configuredName = safeDimension(configured?.name) ?? 'http.request'
	const performance = configured?.performance
	const measureRequest = safelyReflect(() => performance && hasSafePrototype(performance)
		? capturePerformanceMethod(performance, 'measureRequest') as NonNullable<PerformancePort['measureRequest']> | undefined
		: undefined)

	return async(request: TRequest): Promise<TResponse> => {
		if (!configured || !measureRequest) {
			return handler(request)
		}

		const requestSize =
			safelyReadSize(configured.getRequestSize, request) ??
			parseContentLength(getHeader(readFetchProperty(request, 'headers') as FetchLikeRequest['headers'], 'content-length'))
		const readMethod = readFetchProperty(request, 'method')
		const method = typeof readMethod !== 'string' ? 'GET'
			: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(readMethod) ? readMethod : 'UNKNOWN'

		const hostKind = safeDimension(configured.hostKind)
		const runtime = safeDimension(configured.runtime)
		const metadata: HttpPerfMetadata = {
			method,
			route: configuredRoute
		}
		if (hostKind) metadata.hostKind = hostKind
		if (runtime) metadata.runtime = runtime
		if (requestSize !== undefined) metadata.requestSize = requestSize

		let operationPromise: Promise<TResponse> | undefined
		const invokeOnce = (): Promise<TResponse> => {
			operationPromise ??= Promise.resolve().then(() => handler(request))
			return operationPromise
		}
		try {
			const instrumentation = measureRequest(
				configuredName,
				async() => {
					const response = await invokeOnce()
					const status = readFetchProperty(response, 'status')
					if (typeof status === 'number') metadata.statusCode = status
					const responseSize =
						safelyReadSize(configured.getResponseSize, response) ??
						parseContentLength(getHeader(
							readFetchProperty(response, 'headers') as FetchLikeResponse['headers'], 'content-length'
						))
					if (responseSize !== undefined) metadata.responseSize = responseSize
					return response
				},
				metadata,
				configured.labels
			)
			ignorePromiseRejection(instrumentation)
			await 0
		} catch {
			// The handler result is authoritative; measurement failures are isolated.
		}
		return invokeOnce()
	}
}
