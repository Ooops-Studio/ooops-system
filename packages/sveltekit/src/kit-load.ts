import type {SpanOptions, TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {measureAsyncOperation} from '@ooopsstudio/sdk/performance'
import type {Action, ServerLoad} from '@sveltejs/kit'

import {buildServerLabels, mergeLabels, resolveRouteFromValue} from './labels'
import {runWithOptionalTracing} from './optional-tracing'
import {snapshotAdapterOptions} from './options'
import type {
	MaybePromise,
	RouteResolverOptions,
	SvelteActionEventLike,
	SvelteLoadEventLike
} from './types'

export interface InstrumentLoadOptions<TEvent = Parameters<ServerLoad>[0]>
	extends RouteResolverOptions<TEvent> {
	name?: string
}

export interface InstrumentActionOptions<TEvent = Parameters<Action>[0]>
	extends RouteResolverOptions<TEvent> {
	name?: string
	action?: string
}

const LOAD_OPTION_KEYS: readonly (keyof InstrumentLoadOptions<never>)[] = [
	'performance', 'tracing', 'route', 'labels', 'getRoute', 'name'
]
const ACTION_OPTION_KEYS: readonly (keyof InstrumentActionOptions<never>)[] = [
	...LOAD_OPTION_KEYS, 'action'
]

const runWithTracing = async <TResult>(
	name: string,
	tracing: RouteResolverOptions<unknown>['tracing'],
	labels: Readonly<Record<string, string>>,
	operation: (span?: TracingSpan) => Promise<TResult>
): Promise<TResult> => {
	const options: SpanOptions = {kind: 'internal', attributes: {...labels}}
	return await runWithOptionalTracing(tracing, name, operation, options)
}

export function instrumentLoad<TLoad extends ServerLoad>(
	load: TLoad,
	options?: InstrumentLoadOptions<Parameters<TLoad>[0]>
): TLoad
// Overload implementation intentionally shares the public SvelteKit name.
// eslint-disable-next-line no-redeclare
export function instrumentLoad<TEvent extends SvelteLoadEventLike, TResult>(
	load: (event: TEvent) => MaybePromise<TResult>,
	options: InstrumentLoadOptions<TEvent> = {}
): (event: TEvent) => Promise<TResult> {
	const configured = snapshotAdapterOptions(options, LOAD_OPTION_KEYS as readonly (keyof InstrumentLoadOptions<TEvent>)[])
	return async(event: TEvent): Promise<TResult> => {
		const route = resolveRouteFromValue(event, configured)
		const name = configured.name ?? 'sveltekit.load'
		const labels = buildServerLabels('load', route, configured.labels)
		return await runWithTracing(name, configured.tracing, labels, async() => await measureAsyncOperation(
			configured.performance, name, async() => await load(event), labels
		))
	}
}

export function instrumentAction<TAction extends Action>(
	action: TAction,
	options?: InstrumentActionOptions<Parameters<TAction>[0]>
): TAction
// Overload implementation intentionally shares the public SvelteKit name.
// eslint-disable-next-line no-redeclare
export function instrumentAction<TEvent extends SvelteActionEventLike, TResult>(
	action: (event: TEvent) => MaybePromise<TResult>,
	options: InstrumentActionOptions<TEvent> = {}
): (event: TEvent) => Promise<TResult> {
	const configured = snapshotAdapterOptions(options, ACTION_OPTION_KEYS as readonly (keyof InstrumentActionOptions<TEvent>)[])
	let inferredActionName = ''
	try { inferredActionName = action.name } catch { /* anonymous fallback */ }
	const actionName = configured.action ?? inferredActionName ?? 'default'
	return async(event: TEvent): Promise<TResult> => {
		const route = resolveRouteFromValue(event, configured)
		const name = configured.name ?? 'sveltekit.action'
		const labels = buildServerLabels('action', route, mergeLabels(configured.labels, {action: actionName}))
		return await runWithTracing(name, configured.tracing, labels, async() => await measureAsyncOperation(
			configured.performance, name, async() => await action(event), labels
		))
	}
}
