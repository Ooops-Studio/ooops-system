import {ConfigValidationError} from '../utils/config-validation'

import {snapshotPresetOptions} from './preset-options'
import type {OtlpMetricsOptions} from './production-otlp'
import type {PrometheusMetricsOptions} from './production-prometheus'
import type {ManagedMetrics, PrometheusManagedMetrics} from './types'

export type ProductionMetricsTransport =
	| {readonly kind: 'prometheus'}
	| {readonly kind: 'otlp'; readonly endpoint: string; readonly headers?: Record<string, string>}

export interface ProductionMetricsOptions extends Omit<PrometheusMetricsOptions, 'transport'> {
	readonly transport: ProductionMetricsTransport
}

export type {PrometheusMetricsHandlerPort} from './production-prometheus'

export const createProductionMetrics = async<T extends ProductionMetricsOptions>(
	options: T
): Promise<T['transport'] extends {readonly kind: 'prometheus'}
	? PrometheusManagedMetrics
	: ManagedMetrics> => {
	if (!options || typeof options !== 'object')
		throw new ConfigValidationError('Production metrics requires options')
	const stable = snapshotPresetOptions(options, new Set([
		'transport', 'lifecycle', 'resource', 'errors', 'logger', 'clock', 'instruments'
	]), 'Production metrics options') as unknown as ProductionMetricsOptions
	if (!stable.transport)
		throw new ConfigValidationError('Production metrics requires a transport')
	const transport = snapshotTransport(stable.transport)
	if (transport.kind === 'prometheus') {
		const {transport: _transport, ...common} = stable
		const {createPrometheusMetrics} = await import('./production-prometheus')
		return await createPrometheusMetrics(common) as T['transport'] extends {readonly kind: 'prometheus'}
			? PrometheusManagedMetrics
			: ManagedMetrics
	}
	const {transport: _transport, ...common} = stable
	const {createOtlpMetrics} = await import('./production-otlp')
	return await createOtlpMetrics({
		...common,
		endpoint: transport.endpoint,
		...(transport.headers ? {headers: transport.headers} : {})
	} satisfies OtlpMetricsOptions) as T['transport'] extends {readonly kind: 'prometheus'}
		? PrometheusManagedMetrics
		: ManagedMetrics
}

function snapshotTransport(value: unknown): ProductionMetricsTransport {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ConfigValidationError('Production metrics transport must be an object')
	}
	let descriptors: PropertyDescriptorMap
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype
			|| Object.getOwnPropertySymbols(value).length > 0) throw new Error()
		descriptors = Object.getOwnPropertyDescriptors(value)
	} catch {
		throw new ConfigValidationError('Production metrics transport must contain stable data fields')
	}
	const fields = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => {
		if (!descriptor.enumerable || !('value' in descriptor)) throw new ConfigValidationError('Production metrics transport must contain stable data fields')
		return [key, descriptor.value]
	})) as Record<string, unknown>
	if (fields.kind === 'prometheus' && Object.keys(fields).every((key) => key === 'kind')) {
		return {kind: 'prometheus'}
	}
	if (fields.kind === 'otlp' && Object.keys(fields).every((key) => ['kind', 'endpoint', 'headers'].includes(key))) {
		return {
			kind: 'otlp',
			endpoint: fields.endpoint as string,
			...(fields.headers !== undefined ? {headers: fields.headers as Record<string, string>} : {})
		}
	}
	throw new ConfigValidationError(`Unsupported production metrics transport: ${
		typeof fields.kind === 'string' ? fields.kind.slice(0, 64) : `<${fields.kind === null ? 'null' : typeof fields.kind}>`
	}`)
}
