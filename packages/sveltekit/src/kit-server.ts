import {instrumentFetchHandler} from '@ooopsstudio/sdk/performance'
import type {HandleFetch, RequestHandler} from '@sveltejs/kit'

import {completeHttpSpan, createHttpSpanOptions, failHttpSpan} from './http-tracing'
import {buildServerLabels, resolveRouteFromValue, resolveRouteOverride, resolveSvelteRoute} from './labels'
import {runWithOptionalTracing} from './optional-tracing'
import {snapshotAdapterOptions} from './options'
import type {
	MaybePromise,
	RouteResolverOptions,
	SvelteHandleFetchInputLike,
	SvelteRequestEventLike
} from './types'

export interface InstrumentRequestHandlerOptions<TEvent = Parameters<RequestHandler>[0]>
	extends RouteResolverOptions<TEvent> {
	name?: string
	hostKind?: string
	runtime?: string
}

export interface InstrumentHandleFetchOptions<TInput = Parameters<HandleFetch>[0]>
	extends RouteResolverOptions<TInput> {
	name?: string
	hostKind?: string
	runtime?: string
}

const REQUEST_OPTION_KEYS: readonly (keyof InstrumentRequestHandlerOptions<never>)[] = [
	'performance', 'tracing', 'route', 'labels', 'getRoute', 'name', 'hostKind', 'runtime'
]

const readRequestMethod = (request: unknown): string => {
	try {
		const method = (request as {method?: unknown}).method
		return typeof method === 'string' ? method : 'GET'
	} catch { return 'GET' }
}

const readRequestUrl = (request: unknown): string | undefined => {
	try {
		const url = (request as {url?: unknown}).url
		return typeof url === 'string' ? url : undefined
	} catch { return undefined }
}

const readEventPathname = (input: unknown): string | undefined => {
	try {
		const pathname = (input as {event?: {url?: {pathname?: unknown}}}).event?.url?.pathname
		return typeof pathname === 'string' ? pathname : undefined
	} catch { return undefined }
}

export function instrumentRequestHandler<THandler extends RequestHandler>(
	handler: THandler,
	options?: InstrumentRequestHandlerOptions<Parameters<THandler>[0]>
): THandler
// Overload implementation intentionally shares the public SvelteKit name.
// eslint-disable-next-line no-redeclare
export function instrumentRequestHandler<
	TEvent extends SvelteRequestEventLike<TRequest>,
	TRequest extends Request = Request,
	TResponse extends Response = Response
>(
	handler: (event: TEvent) => MaybePromise<TResponse>,
	options: InstrumentRequestHandlerOptions<TEvent> = {}
): (event: TEvent) => Promise<TResponse> {
	const configured = snapshotAdapterOptions(
		options,
		REQUEST_OPTION_KEYS as readonly (keyof InstrumentRequestHandlerOptions<TEvent>)[]
	)
	return async(event: TEvent): Promise<TResponse> => {
		let request: TRequest
		try { request = event.request } catch { return await handler(event) }
		const route = resolveRouteFromValue(event, configured)
		const labels = buildServerLabels('request', route, configured.labels)
		const wrapped = instrumentFetchHandler(
			async() => await handler(event),
			{
				...(configured.performance ? {performance: configured.performance} : {}),
				name: configured.name ?? 'http.request',
				route,
				hostKind: configured.hostKind ?? 'sveltekit',
				runtime: configured.runtime ?? 'server',
				...(labels ? {labels} : {})
			}
		)
		const execute = async() => await wrapped(request)
		const spanOptions = createHttpSpanOptions('server', readRequestMethod(request), route, labels)
		return await runWithOptionalTracing(configured.tracing, configured.name ?? 'http.request', async(span) => {
			if (!span) return await execute()
			try {
				const response = await execute()
				try {
					const status: unknown = response.status
					if (typeof status === 'number') completeHttpSpan(span, status)
				} catch { /* response metadata is observational */ }
				return response
			} catch(error) {
				failHttpSpan(span, error)
				throw error
			}
		}, spanOptions)
	}
}

export function instrumentHandleFetch<THandleFetch extends HandleFetch>(
	handler: THandleFetch,
	options?: InstrumentHandleFetchOptions<Parameters<THandleFetch>[0]>
): THandleFetch
// Overload implementation intentionally shares the public SvelteKit name.
// eslint-disable-next-line no-redeclare
export function instrumentHandleFetch<
	TInput extends SvelteHandleFetchInputLike<TRequest, TResponse>,
	TRequest extends Request = Request,
	TResponse extends Response = Response
>(
	handler: (input: TInput) => MaybePromise<TResponse>,
	options: InstrumentHandleFetchOptions<TInput> = {}
): (input: TInput) => Promise<TResponse> {
	const configured = snapshotAdapterOptions(
		options,
		REQUEST_OPTION_KEYS as readonly (keyof InstrumentHandleFetchOptions<TInput>)[]
	)
	return async(input: TInput): Promise<TResponse> => {
		let request: TRequest
		try { request = input.request } catch { return await handler(input) }
		const route = resolveRouteOverride(input, configured)
			?? readRequestUrl(request)
			?? readEventPathname(input)
			?? '/'
		const resolvedRoute = resolveSvelteRoute(undefined, route)
		const labels = buildServerLabels('fetch', resolvedRoute, configured.labels)

		const wrapped = instrumentFetchHandler(
			async() => await handler(input),
			{
				...(configured.performance ? {performance: configured.performance} : {}),
				name: configured.name ?? 'http.client',
				route: resolvedRoute,
				hostKind: configured.hostKind ?? 'sveltekit',
				runtime: configured.runtime ?? 'server',
				labels
			}
		)
		const execute = async() => await wrapped(request)
		const spanOptions = createHttpSpanOptions('client', readRequestMethod(request), resolvedRoute, labels)
		return await runWithOptionalTracing(configured.tracing, configured.name ?? 'http.client', async(span) => {
			if (!span) return await execute()
			try {
				const response = await execute()
				try {
					const status: unknown = response.status
					if (typeof status === 'number') completeHttpSpan(span, status)
				} catch { /* response metadata is observational */ }
				return response
			} catch(error) {
				failHttpSpan(span, error)
				throw error
			}
		}, spanOptions)
	}
}
