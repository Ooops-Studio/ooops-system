import type {JsonValue} from '@ooopsstudio/core'
import type {NormalizedError} from '@ooopsstudio/core/contracts/errors'
import type {TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {normalizeError} from '@ooopsstudio/core/utils'
import {
	instrumentFetchHandler,
	type FetchLikeResponse,
	type InstrumentFetchHandlerOptions
} from '@ooopsstudio/sdk/performance'
import type {Handle, HandleServerError} from '@sveltejs/kit'

import {
	completeHttpSpan,
	createHttpSpanOptions,
	failHttpSpan,
	setHttpRequestSpanAttributes
} from './http-tracing'
import {buildServerLabels, resolveRouteOverride, resolveSvelteRoute} from './labels'
import {runWithOptionalTracing} from './optional-tracing'
import {snapshotAdapterOptions} from './options'
import type {
	ErrorContextOptions,
	MaybePromise,
	SvelteHandleErrorInputLike,
	SvelteHandleInputLike,
	SvelteRequestEventLike,
	TracingContextOptions
} from './types'

export interface InstrumentHandleOptions<
	TInput = Parameters<Handle>[0]
> extends TracingContextOptions<TInput> {
	name?: string
	spanName?: string
	hostKind?: string
	runtime?: string
	getRequestSize?: InstrumentFetchHandlerOptions<Parameters<Handle>[0]['event']['request']>['getRequestSize']
	getResponseSize?: (response: FetchLikeResponse) => number | undefined
}

export interface InstrumentHandleErrorOptions<
	TInput = Parameters<HandleServerError>[0]
> extends ErrorContextOptions<TInput> {
	name?: string
	source?: string
	getSource?: (input: TInput) => string | undefined
}

const HANDLE_OPTION_KEYS: readonly (keyof InstrumentHandleOptions<never>)[] = [
	'performance', 'tracing', 'route', 'labels', 'getRoute', 'name', 'spanName',
	'hostKind', 'runtime', 'getRequestSize', 'getResponseSize'
]
const HANDLE_ERROR_OPTION_KEYS: readonly (keyof InstrumentHandleErrorOptions<never>)[] = [
	'performance', 'tracing', 'route', 'labels', 'getRoute', 'errors', 'logger',
	'name', 'source', 'getSource'
]

const setRequestSpanAttributes = (
	span: TracingSpan,
	route: string,
	method: string,
	hostKind: string,
	runtime: string
): void => {
	setHttpRequestSpanAttributes(span, method, route)
	try { span.setAttribute('ooops.host_kind', hostKind) } catch { /* tracing is fail-open */ }
	try { span.setAttribute('ooops.runtime', runtime) } catch { /* tracing is fail-open */ }
}

const reportHandleError = (
	normalized: NormalizedError,
	route: string,
	options: InstrumentHandleErrorOptions<SvelteHandleErrorInputLike>,
	input: SvelteHandleErrorInputLike
): void => {
	const traceId = options.tracing?.currentTraceId?.()
	const source = options.getSource?.(input) ?? input.source ?? options.source ?? 'sveltekit.handleError'
	const attributes: Record<string, JsonValue> = {
		hook: 'handleError',
		route,
		source,
		runtime: 'server',
		errorKind: normalized.kind,
		errorMessage: normalized.message,
		...(traceId ? {traceId} : {}),
		...(input.status !== undefined ? {statusCode: input.status} : {}),
		...(input.message ? {statusMessage: input.message} : {})
	}

	options.errors?.report(normalized, attributes)
	options.logger?.error(options.name ?? 'sveltekit.handle_error', attributes)
}

export function instrumentHandle(handler: Handle, options?: InstrumentHandleOptions): Handle
// Overload implementation intentionally shares the public SvelteKit name.
// eslint-disable-next-line no-redeclare
export function instrumentHandle<
	TInput extends SvelteHandleInputLike<TEvent, TResponse>,
	TEvent extends SvelteRequestEventLike = SvelteRequestEventLike,
	TResponse extends FetchLikeResponse = Response
>(
	handler: (input: TInput) => MaybePromise<TResponse>,
	options: InstrumentHandleOptions<TInput> = {}
): (input: TInput) => Promise<TResponse> {
	const configured = snapshotAdapterOptions(options, HANDLE_OPTION_KEYS as readonly (keyof InstrumentHandleOptions<TInput>)[])
	return async(input: TInput): Promise<TResponse> => {
		let event: TEvent
		let request: TEvent['request']
		try {
			event = input.event
			request = event.request
		} catch {
			return await handler(input)
		}
		let routeId: string | null | undefined
		let pathname: string | undefined
		try { routeId = event.route?.id } catch { /* route metadata is observational */ }
		try { pathname = event.url?.pathname } catch { /* route metadata is observational */ }
		const route = resolveSvelteRoute(
			routeId,
			pathname,
			resolveRouteOverride(input, configured)
		)
		let method = 'GET'
		try { if (typeof request.method === 'string') method = request.method } catch { /* request metadata is observational */ }
		const hostKind = configured.hostKind ?? 'sveltekit'
		const runtime = configured.runtime ?? 'server'
		const measureName = configured.name ?? 'http.request'
		const labels = buildServerLabels('handle', route, configured.labels)
		const getRequestSize = configured.getRequestSize as
			| ((request: TEvent['request']) => number | undefined)
			| undefined

		const runRequest = async(span?: TracingSpan): Promise<TResponse> => {
			const execute = async(): Promise<TResponse> => {
				const response = await handler(input)
				if (span) {
					try {
						const status: unknown = response.status
						if (typeof status === 'number') completeHttpSpan(span, status)
					} catch { /* response metadata is observational */ }
				}
				return response
			}

			try {
				return await instrumentFetchHandler<TEvent['request'], TResponse>(
					async() => await execute(),
					{
						...(configured.performance ? {performance: configured.performance} : {}),
						name: measureName,
						route,
						hostKind,
						runtime,
						labels,
						...(getRequestSize ? {getRequestSize} : {}),
						...(configured.getResponseSize ? {getResponseSize: configured.getResponseSize} : {})
					}
				)(request)
			} catch(error) {
				if (span) failHttpSpan(span, error)
				throw error
			}
		}

		const spanOptions = createHttpSpanOptions('server', method, route, {
			'ooops.host_kind': hostKind,
			'ooops.runtime': runtime
		})

		return await runWithOptionalTracing(
			configured.tracing,
			configured.spanName ?? 'sveltekit.handle',
			async(span) => {
				if (span) setRequestSpanAttributes(span, route, method, hostKind, runtime)
				return await runRequest(span)
			},
			spanOptions
		)
	}
}

export function instrumentHandleError(
	handler?: HandleServerError,
	options?: InstrumentHandleErrorOptions
): HandleServerError
// Overload implementation intentionally shares the public SvelteKit name.
// eslint-disable-next-line no-redeclare
export function instrumentHandleError<
	TInput extends SvelteHandleErrorInputLike<TEvent>,
	TEvent extends SvelteRequestEventLike | import('./types').RouteContextLike = import('./types').RouteContextLike,
	TResult = void
>(
	handler?: (input: TInput) => MaybePromise<TResult>,
	options: InstrumentHandleErrorOptions<TInput> = {}
): (input: TInput) => Promise<TResult | undefined> {
	const configured = snapshotAdapterOptions(
		options,
		HANDLE_ERROR_OPTION_KEYS as readonly (keyof InstrumentHandleErrorOptions<TInput>)[]
	)
	return async(input: TInput): Promise<TResult | undefined> => {
		try {
			const route = resolveSvelteRoute(
				input.event.route?.id,
				input.event.url?.pathname,
				resolveRouteOverride(input, configured)
			)
			const normalized = normalizeError(input.error)
			reportHandleError(
				normalized,
				route,
				configured as unknown as InstrumentHandleErrorOptions<SvelteHandleErrorInputLike>,
				input
			)
		} catch {
			// Best-effort only. Never break SvelteKit error handling.
		}

		return await handler?.(input)
	}
}
