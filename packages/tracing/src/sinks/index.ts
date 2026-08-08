import type {Clock} from '@ooopsstudio/core/contracts/clock'

import {createHttpOtlpExporter} from '../features/exporters/http-otlp-exporter'
import {snapshotDataFields} from '../utils/capabilities'

import {createPublicHttpsTransport} from './public-https'
import type {OtlpRemoteConfig} from './types'

/** Creates the fixed OTLP/HTTP transport used by production tracing. */
export function createOtlpRemoteExporter(remote: OtlpRemoteConfig, clock?: Clock, requirePublicEndpoint = false) {
	const snapshot = snapshotOtlpRemoteConfig(remote)
	return createHttpOtlpExporter({
		endpoint: snapshot.endpoint,
		...(snapshot.headers ? {headers: snapshot.headers} : {}),
		timeoutMs: 10_000,
		compress: true,
		...(requirePublicEndpoint ? {transport: createPublicHttpsTransport(snapshot.endpoint, 64 * 1_024)} : {}),
		...(clock ? {clock} : {})
	})
}

export function snapshotOtlpRemoteConfig(remote: OtlpRemoteConfig): OtlpRemoteConfig {
	const values = snapshotDataObject(remote, new Set(['endpoint', 'headers']), 'Tracing OTLP remote')
	if (typeof values.endpoint !== 'string' || values.endpoint.length === 0 || values.endpoint.length > 4_096) {
		throw new Error('Tracing OTLP remote endpoint must contain 1-4096 characters')
	}
	if (!values.endpoint.trim()) throw new Error('Tracing OTLP remote endpoint is required')
	let headers: Readonly<Record<string, string>> | undefined
	if (values.headers !== undefined) {
		headers = snapshotHeaders(values.headers)
	}
	return Object.freeze({
		endpoint: values.endpoint,
		...(headers ? {headers} : {})
	})
}

function snapshotHeaders(value: unknown): Readonly<Record<string, string>> {
	try {
		const result = snapshotDataFields(value, 100, 256)
		if (Object.values(result).some((entry) => typeof entry !== 'string')) throw new TypeError()
		return result as Readonly<Record<string, string>>
	} catch {
		throw new TypeError('Tracing OTLP headers must contain at most 100 string data fields')
	}
}

function snapshotDataObject(
	value: unknown,
	allowedKeys: ReadonlySet<string> | undefined,
	label: string
): Record<string, unknown> {
	try {
		return snapshotDataFields(
			value, allowedKeys?.size ?? 256, allowedKeys ? 64 : 256, allowedKeys
		) as Record<string, unknown>
	} catch {
		throw new TypeError(`${label} must be a closed plain data object`)
	}
}

export type {OtlpRemoteConfig} from './types'
