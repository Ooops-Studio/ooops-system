/**
 * @file Service-stage error reporter utility.
 * Handles recursion guards, optional Errors port, and fixed metadata.
 * Used by services to report internal stage errors without creating infinite loops.
 */

import {AsyncLocalStorage} from 'node:async_hooks'

import type {LogAttributes} from '../../contracts/logging'
import type {Errors} from '../../ports/errors'
import {normalizeError} from '../../utils/error/normalize-error'
import {hasSafePrototypeChain, isProxyObject} from '../../utils/safe-object'
import {serialize} from '../../utils/serialization/serialize-error'
import {
	containNativePromiseUnchecked,
	createNativePromise,
	isolateUnexpectedThenable,
	observeNativePromiseSettlement
} from '../async/native-promise'
import {captureNativePromise} from '../async/safe-abort-controller'
import {
	addNativeSet,
	deleteNativeSet,
	getNativeWeakMap,
	hasNativeSet,
	setNativeWeakMap,
	sizeNativeSet
} from '../collections/native-collections'

// Note: Registry lookup removed in token-based DI architecture
// Errors port must be explicitly provided

/** Track reports per Errors port. A global set incorrectly suppresses a valid
 * report when the same Error is intentionally sent to a different port. */
const activeErrorsByPort = new WeakMap<object, Set<object>>()
const MAX_ACTIVE_SERVICE_ERROR_REPORTS = 1_000
const nativeReflectApply = Reflect.apply
const nativeArrayIsArray = Array.isArray
const nativeJsonParse = JSON.parse.bind(JSON)
const nativeObjectCreate = Object.create
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeObjectGetPrototypeOf = Object.getPrototypeOf
const nativeObjectHasOwn = Object.hasOwn
const NativeSet = Set
const nativeObjectPrototype = Object.prototype
const nativeAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const nativeAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore

type ReportMethod = (...args: unknown[]) => unknown

function readReporterOption(value: unknown, key: keyof ServiceErrorReporterOptions): unknown {
	containNativePromiseUnchecked(value)
	if (!value || typeof value !== 'object') return undefined
	if (isProxyObject(value)) throw new TypeError('Service error reporter options must not be a Proxy')
	try {
		const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key)
		if (!descriptor) return undefined
		if (!('value' in descriptor)) throw new TypeError('Service error reporter options must use data properties')
		containNativePromiseUnchecked(descriptor.value)
		return descriptor.value
	} catch(error) {
		if (error instanceof TypeError) throw error
		throw new TypeError('Service error reporter options cannot be inspected safely')
	}
}

function captureReportMethod(value: unknown): ReportMethod | undefined {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	if (isProxyObject(value)) return undefined
	let current: object | null = value as object
	try {
		for (let depth = 0; current && current !== nativeObjectPrototype && depth < 16; depth += 1) {
			if (isProxyObject(current)) return undefined
			const descriptor = nativeObjectGetOwnPropertyDescriptor(current, 'report')
			if (descriptor) {
				if (!('value' in descriptor)) return undefined
				containNativePromiseUnchecked(descriptor.value)
				return typeof descriptor.value === 'function' ? descriptor.value as ReportMethod : undefined
			}
			current = nativeObjectGetPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

/**
 * Options for creating a service error reporter.
 */
export interface ServiceErrorReporterOptions {

	/** Optional errors port (if provided, used directly) */
	errors?: Errors

	/** Fixed context to include with all errors */
	fixedContext?: Record<string, unknown>

	/** Service name for context (e.g., 'logging', 'tracing') */
	serviceName: string
}

function copyReportContext(target: Record<string, unknown>, source: Record<string, unknown> | undefined): void {
	containNativePromiseUnchecked(source)
	if (!source) return
	if (!hasSafePrototypeChain(source)) return
	try {
		let fields = 0
		for (const key in source) {
			if (!nativeObjectHasOwn(source, key)) break
			if (++fields > 200) break
			if (key.length === 0 || key.length > 128
				|| key === '__proto__' || key === 'prototype' || key === 'constructor') continue
			const descriptor = nativeObjectGetOwnPropertyDescriptor(source, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) continue
			containNativePromiseUnchecked(descriptor.value)
			// Never execute or expose accessor-backed values at an observability
			// boundary. Omitting an unreadable field is safer than manufacturing a
			// caller-controlled key with a diagnostic placeholder.
			target[key] = descriptor.value
		}
	} catch { /* Isolate hostile enumeration and descriptor traps. */ }
}

function snapshotReportContext(context: Record<string, unknown>, serviceName: string): LogAttributes {
	try {
		const parsed = nativeJsonParse(serialize(context, {maxDepth: 8, includeStack: false})) as unknown
		if (parsed && typeof parsed === 'object' && !nativeArrayIsArray(parsed)) {
			const snapshot = nativeObjectCreate(null) as Record<string, unknown>
			let fields = 0
			for (const key in parsed) {
				if (++fields > 400) break
				const descriptor = nativeObjectGetOwnPropertyDescriptor(parsed, key)
				if (descriptor?.enumerable && 'value' in descriptor) snapshot[key] = descriptor.value
			}
			return snapshot as LogAttributes
		}
	} catch { /* Use a bounded mandatory context below. */ }
	const source = serviceName.length <= 256 ? serviceName : '[DROPPED_OVERSIZED]'
	const fallback = nativeObjectCreate(null) as Record<string, string>
	fallback.source = source
	fallback.stage = source
	return fallback
}

/**
 * Create an error reporter function for service stages.
 * Uses errors port directly if provided.
 * In token-based DI architecture, errors port must be explicitly provided.
 *
 * @param options - Reporter options
 * @returns Error handler function
 */
export function createServiceErrorReporter(
	options: ServiceErrorReporterOptions
): (error: unknown, extra?: Record<string, unknown>) => void {
	if (isolateUnexpectedThenable(options)) throw new TypeError('Service error reporter options must be synchronous')
	const providedErrors = readReporterOption(options, 'errors') as Errors | undefined
	const fixedContext = readReporterOption(options, 'fixedContext') as Record<string, unknown> | undefined
	if (isolateUnexpectedThenable(providedErrors) || isolateUnexpectedThenable(fixedContext)) {
		throw new TypeError('Service error reporter capabilities must be synchronous')
	}
	const serviceName = readReporterOption(options, 'serviceName')
	if (typeof serviceName !== 'string' || serviceName.length === 0 || serviceName.length > 256) {
		throw new TypeError('Service error reporter serviceName must be a string of 1-256 characters')
	}
	const report = captureReportMethod(providedErrors)
	const activeReports = new NativeSet<Promise<void>>()
	let invokingReport = false
	const reportInvocationContext = new AsyncLocalStorage<boolean>()
	const isReportInvocation = (): boolean => {
		if (invokingReport) return true
		try {
			return nativeReflectApply(
				nativeAsyncLocalStorageGetStore, reportInvocationContext, []
			) === true
		} catch { return true }
	}

	return (err: unknown, extra?: Record<string, unknown>) => {
		containNativePromiseUnchecked(err)
		if (isReportInvocation()) return

		// Recursion guard is scoped to the destination and to the active report.
		// Permanently remembering an Error object silently dropped later incidents
		// when an integration legitimately reused the same failure instance.
		const hasObjectPort = providedErrors !== null && providedErrors !== undefined &&
			(typeof providedErrors === 'object' || typeof providedErrors === 'function')
		const objectError = err && typeof err === 'object' ? err : undefined
		let activeErrors: Set<object> | undefined
		if (hasObjectPort && objectError && report) {
			activeErrors = getNativeWeakMap(activeErrorsByPort, providedErrors)
			if (!activeErrors) {
				activeErrors = new NativeSet<object>()
				setNativeWeakMap(activeErrorsByPort, providedErrors, activeErrors)
			}
			if (hasNativeSet(activeErrors, objectError)) return
			addNativeSet(activeErrors, objectError)
		}
		const releaseObjectError = (): void => {
			if (objectError && activeErrors) deleteNativeSet(activeErrors, objectError)
		}

		// Merge fixed context with extra context if provided
		const context = nativeObjectCreate(null) as Record<string, unknown>

		// Merge fixed context first
		copyReportContext(context, fixedContext)

		// Merge extra context (so it can override fixed context fields)
		copyReportContext(context, extra)

		// Preserve the originating service across the Errors boundary. Reporters use
		// this marker to avoid sending a metrics/tracing/logging failure back through
		// the same broken integration and creating an asynchronous feedback loop.
		context.source = serviceName

		// Add stage: serviceName only if stage is not already set.
		if (!('stage' in context)) {
			context.stage = serviceName
		}

		// If context is empty, pass empty object to match expected behavior
		// Cast to LogAttributes since values should be JSON-safe (JsonValue)
		const finalContext = snapshotReportContext(context, serviceName)

		// Use provided errors port if available
		if (providedErrors && report) {
			if (sizeNativeSet(activeReports) >= MAX_ACTIVE_SERVICE_ERROR_REPORTS) {
				releaseObjectError()
				return
			}
			let releaseOwnership!: () => void
			const ownership = createNativePromise<void>((resolve) => { releaseOwnership = resolve })
			addNativeSet(activeReports, ownership)
			const release = (): void => {
				// Every guard owns independent cleanup. Promise-resolution hooks or a
				// future helper regression must not strand the reused-error suppression.
				try { deleteNativeSet(activeReports, ownership) } finally {
					try { releaseObjectError() } finally { releaseOwnership() }
				}
			}
			try {
				// Normalize error before reporting - errors.report expects NormalizedError
				const normalized = normalizeError(err)
				let result: unknown
				invokingReport = true
				try {
					result = nativeReflectApply(
						nativeAsyncLocalStorageRun, reportInvocationContext,
						[true, () => nativeReflectApply(report, providedErrors, [normalized, finalContext])]
					)
				} finally { invokingReport = false }
				// Errors.report is a synchronous fire-and-forget port. Tolerate native
				// promise implementations for completion tracking, but do not execute a
				// caller-controlled thenable after the synchronous recursion guard drops.
				const completion = captureNativePromise(result)
				if (completion) {
					if (!observeNativePromiseSettlement(completion, release, release)) release()
				} else release()
			} catch(error) {
				containNativePromiseUnchecked(error)
				// Silently handle errors in error reporting to prevent cascading failures
				release()
			}
		} else releaseObjectError()
		// Silent failure if no errors port available
	}
}
