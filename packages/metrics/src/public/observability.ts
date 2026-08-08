import type {MetricsExemplarMetadata, ObservabilityResource} from '@ooopsstudio/core/contracts/observability-shared'
import {snapshotPlainDataRecord} from '@ooopsstudio/core/utils/validation'

import {createExemplar, extractCorrelationContext, type CorrelationContext} from '../utils/correlation-context'

export function observabilityResourceToMetricLabels(
	resource?: ObservabilityResource
): Record<string, string> {
	if (!resource) {
		return {}
	}
	const stable = snapshotPlainDataRecord(resource, new Set([
		'serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime', 'attributes'
	]), ['serviceName'])
	if (!stable || typeof stable.serviceName !== 'string' || stable.serviceName.length === 0) {
		throw new Error('Metrics observability resource must expose a non-empty serviceName data field')
	}
	for (const field of ['serviceVersion', 'deploymentEnvironment', 'hostKind', 'runtime'] as const) {
		if (stable[field] !== undefined && typeof stable[field] !== 'string') {
			throw new Error(`Metrics observability resource ${field} must be a string`)
		}
	}
	return {
		service_name: stable.serviceName,
		...(stable.serviceVersion ? {service_version: stable.serviceVersion as string} : {}),
		...(stable.deploymentEnvironment ? {deployment_environment: stable.deploymentEnvironment as string} : {}),
		...(stable.hostKind ? {host_kind: stable.hostKind as string} : {}),
		...(stable.runtime ? {runtime: stable.runtime as string} : {})
	}
}

export type {
	CorrelationContext,
	MetricsExemplarMetadata
}
export {
	createExemplar,
	extractCorrelationContext
}
