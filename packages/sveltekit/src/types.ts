import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {FetchLikeRequest, FetchLikeResponse} from '@ooopsstudio/sdk/performance'

export type MaybePromise<T> = T | Promise<T>

export interface RouteLike {
	id?: string | null
}

export interface UrlLike {
	pathname: string
}

export interface RouteContextLike {
	route?: RouteLike
	url?: UrlLike
}

export interface SvelteRequestEventLike<TRequest extends FetchLikeRequest = FetchLikeRequest> {
	request: TRequest
	route?: RouteLike
	url: UrlLike
}

export interface SvelteHandleFetchInputLike<
	TRequest extends FetchLikeRequest = FetchLikeRequest,
	TResponse extends FetchLikeResponse = FetchLikeResponse
> {
	event?: RouteContextLike
	request: TRequest
	fetch(request: TRequest): Promise<TResponse>
}

export interface SvelteHandleInputLike<
	TEvent extends SvelteRequestEventLike = SvelteRequestEventLike,
	TResponse extends FetchLikeResponse = FetchLikeResponse
> {
	event: TEvent
	resolve(event: TEvent): Promise<TResponse>
}

export interface SvelteLoadEventLike extends RouteContextLike {
	url: UrlLike
}

export interface SvelteActionEventLike extends RouteContextLike {
	request?: FetchLikeRequest
	url: UrlLike
}

export interface SvelteHandleErrorInputLike<
	TEvent extends RouteContextLike = RouteContextLike
> {
	error: unknown
	event: TEvent
	status?: number
	message?: string
	source?: string
}

export interface MetricsContextOptions {
	performance?: PerformancePort
	tracing?: Tracing
	route?: string
	labels?: Record<string, string>
}

export interface MetricsOverrideOptions extends MetricsContextOptions {}

export interface RouteResolverOptions<TValue> extends MetricsContextOptions {
	getRoute?: (value: TValue) => string | undefined
}

export interface TracingContextOptions<TValue> extends RouteResolverOptions<TValue> {
	tracing?: Tracing
}

export type ErrorContextOptions<TValue> = Omit<RouteResolverOptions<TValue>, 'tracing'> & {
	errors?: Errors
	tracing?: Pick<Tracing, 'currentTraceId'>
	logger?: Logging
}
