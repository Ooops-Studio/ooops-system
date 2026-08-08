import type {CacheBackendState, CacheRuntimeState, CacheStatus} from '@ooopsstudio/core/contracts/cache'

import {
	emitCacheTelemetry,
	type CacheTelemetryController,
	type CacheTelemetryOperation
} from '../runtime-capabilities'

import {isCacheTimeoutError} from './runtime-safety'

type DiagnosticAttributes = Record<string, unknown>

export interface CacheOperationDiagnostic {
	complete(attributes?: DiagnosticAttributes): void
	fail(attributes?: DiagnosticAttributes): void
}

const publicOperations: Readonly<Record<string, CacheTelemetryOperation>> = Object.freeze({
	get: 'get',
	'get-many': 'get_many',
	set: 'set',
	'set-many': 'set_many',
	delete: 'delete',
	'delete-many': 'delete_many',
	invalidate: 'invalidate',
	load: 'load',
	'load-many': 'load_many'
})

function failureCode(operation: string): string {
	if (operation.includes('shutdown')) return 'CACHE_SHUTDOWN_FAILURE'
	if (operation.includes('flush')) return 'CACHE_FLUSH_FAILURE'
	if (operation.includes('capacity') || operation.includes('overflow')) return 'CACHE_BACKEND_CAPACITY'
	if (operation.includes('serialize') || operation.includes('decode') || operation.includes('entry')) {
		return 'CACHE_CORRUPT_ENTRY'
	}
	return 'CACHE_BACKEND_FAILURE'
}

function backendOperation(operation: string): 'read' | 'write' | 'delete' | 'invalidate' | 'flush' | 'shutdown' {
	if (operation.includes('shutdown')) return 'shutdown'
	if (operation.includes('flush')) return 'flush'
	if (operation.includes('invalidate')) return 'invalidate'
	if (operation.includes('delete')) return 'delete'
	if (operation.includes('set') || operation.includes('write')) return 'write'
	return 'read'
}

export function createCacheRuntimeObservability() {
	const controller: CacheTelemetryController = {}
	let activeLoads = 0
	let droppedTotal = 0
	let unresolvedTimeouts = 0
	let lastFailureCode: string | undefined
	let finalizationFailure = false

	const emit = (event: Parameters<typeof emitCacheTelemetry>[1]): void => emitCacheTelemetry(controller, event)
	const reportError = (
		error: unknown,
		operation: string,
		_attributes: DiagnosticAttributes = {}
	): void => {
		// Timeout admission and settlement are tracked explicitly. Outer operation
		// boundaries see the same error again and must not replace that state with a
		// generic failure that can no longer be cleared by the late settlement.
		if (isCacheTimeoutError(error)) return
		const code = failureCode(operation)
		lastFailureCode = code
		const finalization = operation.includes('flush') || operation.includes('shutdown') || operation.includes('lifecycle')
		if (finalization) {
			finalizationFailure = true
			emit({
				kind: 'finalization_failed',
				operation: operation.includes('shutdown') ? 'shutdown'
					: operation.includes('flush') ? 'flush' : 'lifecycle_cleanup',
				code
			})
			return
		}
		emit({kind: 'backend_failed', operation: backendOperation(operation), code})
	}
	const recover = (): void => {
		const wasFailing = lastFailureCode !== undefined
		lastFailureCode = undefined
		finalizationFailure = false
		if (wasFailing) emit({kind: 'recovered'})
	}
	const markBackendSuccess = (): void => {
		if (finalizationFailure) return
		if (unresolvedTimeouts > 0) {
			// A successful operation clears newer ordinary failures, but unresolved
			// physical timeouts must keep the backend degraded until they settle.
			lastFailureCode = 'CACHE_BACKEND_TIMEOUT'
			return
		}
		if (lastFailureCode !== undefined) recover()
	}
	const markBackendTimeout = (): void => {
		unresolvedTimeouts++
		lastFailureCode = 'CACHE_BACKEND_TIMEOUT'
		emit({kind: 'backend_failed', operation: 'read', code: 'CACHE_BACKEND_TIMEOUT'})
	}
	const markBackendSettlement = (successful: boolean): void => {
		if (unresolvedTimeouts > 0) unresolvedTimeouts--
		if (successful && unresolvedTimeouts === 0 && !finalizationFailure
			&& lastFailureCode === 'CACHE_BACKEND_TIMEOUT') recover()
	}
	const markFinalizationSuccess = (): void => {
		finalizationFailure = false
		markBackendSuccess()
	}
	const markDropped = (reason: 'capacity' | 'invalid' | 'oversized' | 'closed'): void => {
		droppedTotal++
		emit({kind: 'dropped', reason})
	}
	const beginOperation = (
		operation: string,
		_attributes: DiagnosticAttributes = {},
		_level: 'trace' | 'debug' = 'debug'
	): CacheOperationDiagnostic => {
		let completed = false
		const finish = (result: 'success' | 'failure'): void => {
			if (completed) return
			completed = true
			const mapped = publicOperations[operation]
			if (mapped) emit({kind: 'operation', operation: mapped, result})
		}
		return {complete: () => finish('success'), fail: () => finish('failure')}
	}
	const metric = (name: string, _count = 1, labels: Record<string, string> = {}): void => {
		if (name !== 'cache_lookups_total') return
		const result = labels.outcome === 'miss' ? 'miss'
			: labels.kind === 'negative' ? 'negative'
				: labels.freshness === 'stale' ? 'stale' : 'fresh'
		emit({kind: 'lookup', result})
	}
	const measurement = (
		name: string,
		value: number,
		_labels: Record<string, string> = {}
	): void => {
		if (name === 'cache_active_operations' && Number.isSafeInteger(value) && value >= 0) {
			emit({kind: 'active_operations', count: value})
		}
		if (name === 'cache_single_flight_active' && Number.isSafeInteger(value) && value >= 0) {
			activeLoads = value
			emit({kind: 'active_loads', count: value})
		}
	}
	const snapshot = (
		state: CacheRuntimeState,
		activeOperations: number
	): CacheStatus => {
		const backendState: CacheBackendState = state === 'closed' ? 'closed'
			: finalizationFailure ? 'unhealthy'
				: unresolvedTimeouts > 0 ? 'degraded'
					: lastFailureCode ? 'unhealthy' : 'healthy'
		return Object.freeze({
			state,
			activeOperations,
			activeLoads,
			droppedTotal,
			backendState,
			...(lastFailureCode ? {lastFailureCode} : {})
		})
	}
	return {
		controller,
		reportError,
		beginOperation,
		metric,
		measurement,
		markBackendSuccess,
		markBackendTimeout,
		markBackendSettlement,
		markFinalizationSuccess,
		markDropped,
		recover,
		snapshot,
		diagnosticScope(..._arguments: unknown[]): Record<string, never> { return Object.freeze({}) }
	}
}
