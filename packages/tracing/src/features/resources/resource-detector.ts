/**
 * @file Resource detector for OpenTelemetry resource attributes.
 * Sets service.name, service.version, deployment.environment, host.name, etc.
 */
import {hostname} from 'node:os'

import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'

import {snapshotDataFields} from '../../utils/capabilities'
/**
 * Options for resource detection.
 */
export interface ResourceDetectionOptions {
	/** Service name */
	serviceName?: string
	/** Service version */
	serviceVersion?: string
	/** Deployment environment */
	deploymentEnvironment?: string
	/** Host name */
	hostName?: string
	/** Process PID */
	processPid?: number
	/** Runtime type (e.g., 'nodejs') */
	runtimeType?: string
	/** Runtime version */
	runtimeVersion?: string
}
function isSafeResourceString(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code <= 31 || code === 127) return false
	}
	return true
}

function validateOptions(options: ResourceDetectionOptions): void {
	for (const [key, value] of Object.entries(options)) {
		if (key === 'processPid') continue
		if (value !== undefined && !isSafeResourceString(value)) throw new Error(`Tracing resource ${key} must be a non-empty string of at most 256 safe characters`)
	}
	if (options.processPid !== undefined && (!Number.isSafeInteger(options.processPid) || options.processPid <= 0)) {
		throw new Error('Tracing resource processPid must be a positive safe integer')
	}
}
const RESOURCE_OPTION_KEYS = new Set([
	'serviceName', 'serviceVersion', 'deploymentEnvironment', 'hostName',
	'processPid', 'runtimeType', 'runtimeVersion'
])

function snapshotResourceOptions(options: ResourceDetectionOptions): ResourceDetectionOptions {
	try {
		return snapshotDataFields(options, RESOURCE_OPTION_KEYS.size, 64, RESOURCE_OPTION_KEYS) as ResourceDetectionOptions
	} catch {
		throw new TypeError('Tracing resource options must be a closed plain data object')
	}
}
/**
 * Detect resource attributes from environment and system.
 * @param options - Optional overrides
 * @returns Resource attributes
 */
export function detectResource(options: ResourceDetectionOptions = {}): LogAttributes {
	const safeOptions = snapshotResourceOptions(options)
	validateOptions(safeOptions)
	const attrs: Record<string, unknown> = {}
	// Service attributes
	if (safeOptions.serviceName) {
		attrs['service.name'] = safeOptions.serviceName
	} else if (typeof process !== 'undefined' && isSafeResourceString(process.env.SERVICE_NAME)) {
		attrs['service.name'] = process.env.SERVICE_NAME
	}
	if (safeOptions.serviceVersion) {
		attrs['service.version'] = safeOptions.serviceVersion
	} else if (typeof process !== 'undefined' && isSafeResourceString(process.env.SERVICE_VERSION)) {
		attrs['service.version'] = process.env.SERVICE_VERSION
	}
	// Deployment environment
	if (safeOptions.deploymentEnvironment) {
		attrs['deployment.environment'] = safeOptions.deploymentEnvironment
	} else if (typeof process !== 'undefined' && isSafeResourceString(process.env.NODE_ENV)) {
		attrs['deployment.environment'] = process.env.NODE_ENV
	}
	// Host name
	if (safeOptions.hostName) {
		attrs['host.name'] = safeOptions.hostName
	} else if (typeof process !== 'undefined') {
		try {
			const detectedHost = hostname()
			if (isSafeResourceString(detectedHost)) attrs['host.name'] = detectedHost
		} catch { /* host metadata is optional */ }
	}
	// Process PID
	if (safeOptions.processPid !== undefined) {
		attrs['process.pid'] = safeOptions.processPid
	} else if (typeof process !== 'undefined' && process.pid) {
		attrs['process.pid'] = process.pid
	}
	// Runtime type
	if (safeOptions.runtimeType) {
		attrs['runtime.type'] = safeOptions.runtimeType
	} else if (typeof process !== 'undefined' && process.release?.name === 'node') {
		// Default to nodejs only when running in a Node-like environment.
		// In browser or unknown environments, omit runtime.type unless provided explicitly.
		attrs['runtime.type'] = 'nodejs'
	}
	// Runtime version
	if (safeOptions.runtimeVersion) {
		attrs['runtime.version'] = safeOptions.runtimeVersion
	} else if (typeof process !== 'undefined' && isSafeResourceString(process.version)) {
		attrs['runtime.version'] = process.version
	}
	return attrs as LogAttributes
}
