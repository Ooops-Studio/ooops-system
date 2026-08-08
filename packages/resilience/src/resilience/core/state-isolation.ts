/**
 * @file State isolation utilities for tenant/workspace/resource isolation.
 * Provides collision-resistant, privacy-safe state keys.
 */

import {fingerprintResilienceIdentity} from '../utils/sanitizer'

import type {StateIsolationScope, StateIsolationKey} from './internal-types'

/**
 * Create an isolation key with standardized format:
 * {resourceFingerprint}::{scope}:{idFingerprint}.
 *
 * @param resource - Resource identifier (e.g., 'postgres.main', 'r2.assets')
 * @param scope - Isolation scope ('tenant', 'workspace', 'resource', 'user')
 * @param id - Identifier for the scope (e.g., tenant ID, workspace ID)
 * @returns Isolation key in format {resource}::{scope}:{id}
 */
export function createIsolationKey(
	resource: string,
	scope: StateIsolationScope,
	id: string
): StateIsolationKey {

	if (!resource || !scope || !id) {
		throw new Error('[Resilience] createIsolationKey: resource, scope, and id are required')
	}

	// Validate scope
	const validScopes: readonly StateIsolationScope[] = ['tenant', 'workspace', 'resource', 'user']
	if (!validScopes.includes(scope)) {
		throw new Error(`[Resilience] createIsolationKey: scope must be one of ${validScopes.join(', ')}`)
	}

	// Identity keys must be collision-resistant. Observability normalization is
	// deliberately lossy and therefore must never be used for state identity.
	return `${fingerprintResilienceIdentity(resource)}::${scope}:${fingerprintResilienceIdentity(id)}` as StateIsolationKey

}

/**
 * Parse an isolation key into its components.
 *
 * @param key - Isolation key in format {resource}::{scope}:{id}
 * @returns Parsed components or null if invalid format
 */
export function parseIsolationKey(
	key: StateIsolationKey
): {resource: string; scope: StateIsolationScope; id: string} | null {
	if (typeof key !== 'string' || key.length > 256) return null

	const parts = key.split('::')
	if (parts.length !== 2) {
		return null
	}

	const [resource, rest] = parts
	if (!rest) {
		return null
	}
	const scopeIdParts = rest.split(':')
	if (scopeIdParts.length !== 2) {
		return null
	}

	const [scope, id] = scopeIdParts
	if (!resource || !scope || !id) {
		return null
	}

	// Validate scope
	const validScopes: readonly StateIsolationScope[] = ['tenant', 'workspace', 'resource', 'user']
	if (!validScopes.includes(scope as StateIsolationScope)) {
		return null
	}

	return {
		resource,
		scope: scope as StateIsolationScope,
		id
	}

}
