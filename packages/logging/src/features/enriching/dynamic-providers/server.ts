/**
 * @file Server-specific dynamic provider for logging enrichment.
 * Extracts server-side context: requestId, routeId, userId (safe), instanceId, region, ipHash.
 */

import {getContext} from '@ooopsstudio/core/runtime/context'

import type {EnrichingProvider} from '../../../types/enriching'

/**
 * Options for server dynamic provider
 */
export interface ServerDynamicProviderOptions {
	/**
	 * Function to extract request ID from record context or headers
	 * Default: uses correlationId from async context
	 */
	getRequestId?: (record: Readonly<import('@ooopsstudio/core/contracts/logging').LogRecord>) => string | undefined

	/**
	 * Function to extract route ID from record context
	 * Default: looks for routeId in context.attributes
	 */
	getRouteId?: (record: Readonly<import('@ooopsstudio/core/contracts/logging').LogRecord>) => string | undefined

	/**
	 * Function to extract user ID from session/JWT (safe extraction, no raw tokens)
	 * Default: uses userId from async context if available
	 */
	getUserId?: (record: Readonly<import('@ooopsstudio/core/contracts/logging').LogRecord>) => string | undefined

	/**
	 * Instance ID (from process.env or config)
	 * Default: process.env.INSTANCE_ID or process.env.HOSTNAME
	 */
	instanceId?: string

	/**
	 * Region (from process.env or config)
	 * Default: process.env.REGION or process.env.AWS_REGION
	 */
	region?: string

	/**
	 * Opt-in function that returns a privacy-safe, preferably keyed IP digest.
	 * No default is provided because unkeyed IP hashes are enumerable.
	 */
	getIpHash?: (record: Readonly<import('@ooopsstudio/core/contracts/logging').LogRecord>) => string | undefined
}

/**
 * Create server-specific dynamic provider
 * @param options - Provider options
 * @returns Enriching provider function
 */
export function createServerDynamicProvider(
	options: Readonly<ServerDynamicProviderOptions> = {}
): EnrichingProvider {

	const {
		getRequestId,
		getRouteId,
		getUserId,
		instanceId,
		region,
		getIpHash
	} = options
	const environment = (globalThis as {
		process?: {env?: Record<string, string | undefined>}
	}).process?.env

	// Default instance ID from env
	const defaultInstanceId = instanceId ?? environment?.INSTANCE_ID ?? environment?.HOSTNAME

	// Default region from env
	const defaultRegion = region ?? environment?.REGION ?? environment?.AWS_REGION

	return async(record) => {
		const attrs: Record<string, import('@ooopsstudio/core/contracts/json').JsonValue> = {}

		// Request ID: use correlationId from async context or custom getter
		if (getRequestId) {
			const requestId = getRequestId(record)
			if (requestId) attrs.requestId = requestId
		} else {
			const context = getContext()
			if (context?.correlationId) {
				attrs.requestId = context.correlationId
			}
		}

		// Route ID: from context attributes or custom getter
		if (getRouteId) {
			const routeId = getRouteId(record)
			if (routeId) attrs.routeId = routeId
		} else {
			const routeId = record.context?.attributes?.routeId as string | undefined
			if (routeId) attrs.routeId = routeId
		}

		// User ID: safe extraction from async context or custom getter (no raw tokens)
		if (getUserId) {
			const userId = getUserId(record)
			if (userId) attrs.userId = userId
		} else {
			const context = getContext()
			// Only use userId if it's a safe identifier (not a token)
			// This assumes the context userId is already safe
			// (extracted from JWT subject, not the token itself)
			if (context?.userId && typeof context.userId === 'string' && !context.userId.includes('.')) {
				attrs.userId = context.userId
			}
		}

		// Instance ID
		if (defaultInstanceId) {
			attrs.instanceId = defaultInstanceId
		}

		// Region
		if (defaultRegion) {
			attrs.region = defaultRegion
		}

		// IP-derived values are opt-in because an unkeyed hash of an IPv4
		// address is reversible by enumeration.
		if (getIpHash) {
			const ipHash = getIpHash(record)
			if (ipHash) attrs.ipHash = ipHash
		}

		return attrs
	}
}
