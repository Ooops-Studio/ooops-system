import {AsyncLocalStorage} from 'node:async_hooks'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {
	ResilienceClassificationResult,
	ResilienceErrorClassifier,
	ResilienceExecutionContext,
	ResilienceExecutionRequest,
	ResiliencePolicyDefinition,
	ResilienceStatus
} from '@ooopsstudio/core/contracts/resilience'
import {
	BreakerOpenError,
	BulkheadOverflowError,
	ResilienceConfigurationError,
	RetryExhaustedError,
	TimedOutError
} from '@ooopsstudio/core/contracts/resilience'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import type {Tracing, TracingSpan} from '@ooopsstudio/core/ports/tracing'
import {createSafeAbortController} from '@ooopsstudio/core/runtime/async/safe-abort-controller'

import {mergeBuiltinPolicies} from '../defaults/policies/managed-policies'
import type {ManagedResilience, ResilienceClassifierRegistry} from '../public/types'
import {
	emitResilienceTelemetry,
	registerResilienceTelemetryTarget,
	type ResilienceRejectionReason,
	type ResilienceTelemetryController
} from '../runtime-capabilities'
import {captureCapability, captureClock, captureInjectedCapability, captureNativePromise, isolateUnexpectedThenable} from '../utils/capabilities'
import {fingerprintResilienceIdentity, fingerprintResilienceValue, sanitizeResilienceOperationName} from '../utils/sanitizer'

import {classifyBuiltinResilienceError} from './classifiers'
import type {CustomFallbackStage} from './custom-fallback'
import {createPolicyRegistry} from './policy-registry'

const MAX_STATE_PARTITIONS = 2_048
const MAX_ACTIVE_OPERATIONS = 2_048
const MAX_METADATA_KEYS = 32
const MAX_IDENTIFIER_LENGTH = 128
const MAX_METADATA_KEY_LENGTH = 64
const MAX_METADATA_VALUE_LENGTH = 256
const SHUTDOWN_TIMEOUT_MS = 10_000
const MAX_BREAKER_RESULTS = 256
const MAX_COALESCED_RESULT_NODES = 10_000
const MAX_COALESCED_RESULT_DEPTH = 32
const MAX_COALESCED_CONTAINER_ENTRIES = 10_000
const MAX_COALESCED_STRING_UNITS = 1_048_576
const MAX_COALESCED_FOLLOWERS = 64

interface BreakerState {
	state: 'closed' | 'open' | 'half-open'
	generation: number
	openUntil: number
	halfOpenInFlight: number
	halfOpenSuccesses: number
	results: Array<{at: number; failed: boolean}>
	resultsHead: number
	failuresInWindow: number
	/** Do not evict a CLOSED failure history while it can still open the breaker. */
	protectionUntil: number
}

interface BulkheadWaiter {
	resolve(): void
	reject(error: unknown): void
	timer?: ReturnType<typeof setTimeout>
	signal: AbortSignal
	onAbort(): void
}

interface BulkheadState {active: number; queue: BulkheadWaiter[]}
interface RetryBudgetState {remaining: number; windowStartedAt: number; expiresAt: number}
type CoalescedOperation = [Promise<unknown>, number, number]
type CoalescingOwnership = readonly [key: string, parent?: CoalescingOwnership]

const invalidRequest = () => new ResilienceConfigurationError('RESILIENCE_INVALID_REQUEST', 'invalid request')

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
	try { if (timer !== undefined) clearTimeout(timer) } catch { /* cleanup must not corrupt ownership */ }
}

export interface ManagedRuntimeOptions {
	clock: Clock
	policies?: readonly ResiliencePolicyDefinition[]
	classifiers?: ResilienceClassifierRegistry
	fallbackStage?: CustomFallbackStage
	logger?: Logging
	errors?: Errors
	metrics?: MetricsPort
	tracer?: Tracing
	performance?: PerformancePort
	lifecycle?: LifecyclePort
}

function boundedOwnDescriptors(value: object, maximum: number): PropertyDescriptorMap {
	const keys = Reflect.ownKeys(value)
	if (keys.length > maximum) throw new Error()
	const descriptors: PropertyDescriptorMap = Object.create(null)
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (!descriptor || !Reflect.set(descriptors, key, descriptor)) throw new Error()
	}
	return descriptors
}

function snapshotIdentifier(value: unknown): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH || value.trim().length < 1) throw invalidRequest()
	return value
}

function snapshotContext(value: unknown): ResilienceExecutionContext {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest()
	let descriptors: PropertyDescriptorMap
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error()
		descriptors = boundedOwnDescriptors(value, 6)
	} catch { throw invalidRequest() }
	const allowed = new Set(['resource', 'tenantId', 'workspaceId', 'userId', 'correlationId', 'metadata'])
	if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key) || !descriptors[key]?.enumerable || !('value' in descriptors[key]!))) throw invalidRequest()
	let metadata: Record<string, string | number | boolean> | undefined
	if (descriptors.metadata?.value !== undefined) {
		const raw = descriptors.metadata.value
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidRequest()
		let entries: PropertyDescriptorMap
		try { if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) throw new Error(); entries = boundedOwnDescriptors(raw, MAX_METADATA_KEYS) } catch { throw invalidRequest() }
		metadata = Object.create(null)
		for (const [key, descriptor] of Object.entries(entries)) {
			if (key.length < 1 || key.length > MAX_METADATA_KEY_LENGTH || !descriptor.enumerable || !('value' in descriptor) || !['string', 'number', 'boolean'].includes(typeof descriptor.value) || (typeof descriptor.value === 'string' && descriptor.value.length > MAX_METADATA_VALUE_LENGTH) || (typeof descriptor.value === 'number' && !Number.isFinite(descriptor.value))) throw invalidRequest()
			metadata![key] = descriptor.value as string | number | boolean
		}
		Object.freeze(metadata)
	}
	const snapshot: {resource: string; tenantId?: string; workspaceId?: string; userId?: string; correlationId?: string; metadata?: Readonly<Record<string, string | number | boolean>>} = {
		resource: snapshotIdentifier(descriptors.resource?.value)
	}
	for (const key of ['tenantId', 'workspaceId', 'userId', 'correlationId'] as const) {
		const value = descriptors[key]?.value
		if (value !== undefined) snapshot[key] = snapshotIdentifier(value)
	}
	if (metadata) snapshot.metadata = metadata
	return Object.freeze(snapshot)
}

function snapshotRequest(value: unknown): ResilienceExecutionRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidRequest()
	}
	let descriptors: PropertyDescriptorMap
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error()
		descriptors = boundedOwnDescriptors(value, 5)
	} catch {
		throw invalidRequest()
	}
	const allowed = new Set(['operation', 'policy', 'context', 'timeoutMs', 'coalescingKey'])
	if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
		|| !allowed.has(key)
		|| !descriptors[key]?.enumerable
		|| !('value' in descriptors[key]!))) {
		throw invalidRequest()
	}
	return Object.freeze({
		operation: snapshotIdentifier(descriptors.operation?.value),
		policy: snapshotIdentifier(descriptors.policy?.value),
		context: snapshotContext(descriptors.context?.value),
		...(descriptors.timeoutMs?.value !== undefined ? {timeoutMs: descriptors.timeoutMs.value as number} : {}),
		...(descriptors.coalescingKey?.value !== undefined
			? {coalescingKey: snapshotIdentifier(descriptors.coalescingKey.value)}
			: {})
	})
}

function deepFreezeClone<T>(value: T): T {
	const unsafe = () => new ResilienceConfigurationError(
		'RESILIENCE_COALESCED_RESULT_UNSAFE',
		'unsafe coalesced result'
	)
	if (typeof value === 'function' || typeof value === 'symbol') throw unsafe()
	if (value === null || typeof value !== 'object') return value
	type CloneFrame = readonly [object, Record<string, unknown> | unknown[], number, PropertyDescriptorMap]
	type SeenContainer = readonly [Record<string, unknown> | unknown[], number, object?]
	let nodes = 0
	let stringUnits = 0
	let containerEntries = 0
	const frames: CloneFrame[] = []
	const seen = new Map<object, SeenContainer>()
	const cloneContainer = (source: object, depth: number, parent?: object): Record<string, unknown> | unknown[] => {
		if (depth > MAX_COALESCED_RESULT_DEPTH || ++nodes > MAX_COALESCED_RESULT_NODES) throw unsafe()
		let prototype: object | null
		let keys: PropertyKey[]
		try { prototype = Object.getPrototypeOf(source); keys = Reflect.ownKeys(source) } catch { throw unsafe() }
		const array = Array.isArray(source)
		if ((!array && prototype !== Object.prototype && prototype !== null) || (array && prototype !== Array.prototype)) throw unsafe()
		// Bound the cheap key list before materializing a descriptor object, whose
		// per-property allocation would otherwise amplify an oversized result.
		if (keys.length > MAX_COALESCED_CONTAINER_ENTRIES + (array ? 1 : 0)) throw unsafe()
		const descriptors: PropertyDescriptorMap = Object.create(null)
		try {
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(source, key)
				if (!descriptor || !Reflect.set(descriptors, key, descriptor)) throw new Error()
			}
		} catch { throw unsafe() }
		const entryCount = array ? keys.length - (descriptors.length ? 1 : 0) : keys.length
		if (entryCount < 0 || entryCount > MAX_COALESCED_CONTAINER_ENTRIES) throw unsafe()
		const length = array ? descriptors.length?.value : undefined
		if (array && (!Number.isSafeInteger(length) || length < 0 || length > MAX_COALESCED_CONTAINER_ENTRIES)) throw unsafe()
		containerEntries += array ? length as number : entryCount
		if (containerEntries > MAX_COALESCED_CONTAINER_ENTRIES) throw unsafe()
		const target: Record<string, unknown> | unknown[] = array
			? new Array(length as number)
			: Object.create(prototype === null ? null : Object.prototype) as Record<string, unknown>
		seen.set(source, [target, depth, parent])
		frames.push([source, target, depth, descriptors])
		return target
	}
	const cloned = cloneContainer(value, 0)
	while (frames.length > 0) {
		const [source, target, depth, descriptors] = frames.pop()!
		for (const key of Reflect.ownKeys(descriptors)) {
			if (Array.isArray(target) && key === 'length') continue
			const descriptor = descriptors[key as keyof typeof descriptors]
			if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) throw unsafe()
			if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length)) throw unsafe()
			stringUnits += key.length
			const nested = descriptor.value as unknown
			if (typeof nested === 'string') stringUnits += nested.length
			if (stringUnits > MAX_COALESCED_STRING_UNITS || typeof nested === 'function' || typeof nested === 'symbol') throw unsafe()
			let clonedNested = nested
			if (nested !== null && typeof nested === 'object') {
				const existing = seen.get(nested)
				if (existing) {
					let ancestor: object | undefined = source
					while (ancestor !== undefined && ancestor !== nested) ancestor = seen.get(ancestor)?.[2]
					if (ancestor === undefined && depth + 1 > existing[1]) throw unsafe()
					clonedNested = existing[0]
				} else clonedNested = cloneContainer(nested, depth + 1, source)
			}
			try { Object.defineProperty(target, key, {value: clonedNested, enumerable: true, writable: true, configurable: true}) } catch { throw unsafe() }
		}
	}
	const pending: object[] = [cloned]
	const frozen = new WeakSet<object>()
	while (pending.length > 0) {
		const candidate = pending.pop()!
		if (frozen.has(candidate)) continue
		frozen.add(candidate)
		for (const nested of Object.values(candidate)) if (nested && typeof nested === 'object') pending.push(nested)
		Object.freeze(candidate)
	}
	return cloned as T
}

function abortError(): Error { return Object.assign(new Error('Resilience operation cancelled'), {name: 'AbortError', code: 'ABORT_ERR'}) }

const SAFE_FINAL_ERROR_NAME = /^(?:Error|ResilienceError|TimedOutError|BreakerOpenError|BulkheadOverflowError|RetryExhaustedError|ResilienceConfigurationError)$/
const SAFE_FINAL_ERROR_CODE = /^RESILIENCE_(?:FAILURE|TIMEOUT|BREAKER_OPEN|BULKHEAD_OVERFLOW|RETRY_EXHAUSTED|INVALID_(?:CONFIG|REQUEST|TIMEOUT|POLICY_NAME)|UNKNOWN_(?:POLICY|CLASSIFIER|FALLBACK)|NOT_RUNNING|STATE_CAPACITY|ADMISSION_CAPACITY|COALESCING_(?:DISABLED|EXPIRED|CAPACITY)|COALESCED_RESULT_UNSAFE)$/

function finalErrorIdentity(error: unknown): {kind: string; code: string} {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) return {kind: 'ResilienceError', code: 'RESILIENCE_FAILURE'}
	let current: object | null = error as object
	let name: unknown
	let code: unknown
	try {
		for (let depth = 0; current && depth < 8 && (name === undefined || code === undefined); depth++) {
			const nameDescriptor = Object.getOwnPropertyDescriptor(current, 'name')
			const codeDescriptor = Object.getOwnPropertyDescriptor(current, 'code')
			if (nameDescriptor && 'value' in nameDescriptor) name = nameDescriptor.value
			if (codeDescriptor && 'value' in codeDescriptor) code = codeDescriptor.value
			current = Object.getPrototypeOf(current)
		}
	} catch { return {kind: 'ResilienceError', code: 'RESILIENCE_FAILURE'} }
	return {
		kind: typeof name === 'string' && name.length <= 128 && SAFE_FINAL_ERROR_NAME.test(name) ? name : 'ResilienceError',
		code: typeof code === 'string' && code.length <= 128 && SAFE_FINAL_ERROR_CODE.test(code) ? code : 'RESILIENCE_FAILURE'
	}
}

function snapshotClassification(value: unknown): ResilienceClassificationResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {retryable: false}
	let descriptors: PropertyDescriptorMap
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error()
		descriptors = boundedOwnDescriptors(value, 3)
	} catch { return {retryable: false} }
	if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
		|| !['retryable', 'delayMs', 'ambiguousCompletion'].includes(key)
		|| !descriptors[key]?.enumerable
		|| !('value' in descriptors[key]!))) return {retryable: false}
	if (typeof descriptors.retryable?.value !== 'boolean') return {retryable: false}
	const delayMs = descriptors.delayMs?.value
	const ambiguousCompletion = descriptors.ambiguousCompletion?.value
	if (delayMs !== undefined && (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0)) return {retryable: false}
	if (ambiguousCompletion !== undefined && typeof ambiguousCompletion !== 'boolean') return {retryable: false}
	return Object.freeze({
		retryable: descriptors.retryable.value,
		...(delayMs !== undefined ? {delayMs} : {}),
		...(ambiguousCompletion !== undefined ? {ambiguousCompletion} : {})
	})
}

export function createManagedResilienceRuntime(options: ManagedRuntimeOptions): ManagedResilience {
	const clock = captureClock(options.clock)
	const increment = captureCapability<Parameters<NonNullable<MetricsPort['increment']>>, ReturnType<NonNullable<MetricsPort['increment']>>>(options.metrics, 'increment')
	const record = captureCapability<Parameters<NonNullable<MetricsPort['record']>>, ReturnType<NonNullable<MetricsPort['record']>>>(options.metrics, 'record')
	const report = captureInjectedCapability<Parameters<Errors['report']>, ReturnType<Errors['report']>>(options.errors, 'report')
	const warn = captureInjectedCapability<Parameters<Logging['warn']>, ReturnType<Logging['warn']>>(options.logger, 'warn')
	const startSpan = captureInjectedCapability<Parameters<Tracing['startSpan']>, ReturnType<Tracing['startSpan']>>(options.tracer, 'startSpan')
	const measureAsync = captureCapability<Parameters<NonNullable<PerformancePort['measureAsync']>>, ReturnType<NonNullable<PerformancePort['measureAsync']>>>(options.performance, 'measureAsync')
	const registerShutdownHook = captureInjectedCapability<Parameters<LifecyclePort['registerShutdownHook']>, ReturnType<LifecyclePort['registerShutdownHook']>>(options.lifecycle, 'registerShutdownHook')
	const classifiers = new Map<string, ResilienceErrorClassifier>()
	let classifierDescriptors: PropertyDescriptorMap = {}
	if (options.classifiers !== undefined) {
		try {
			if (Object.getPrototypeOf(options.classifiers) !== Object.prototype && Object.getPrototypeOf(options.classifiers) !== null) throw new Error()
			classifierDescriptors = boundedOwnDescriptors(options.classifiers, 64)
		} catch { throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid classifiers') }
	}
	for (const [name, descriptor] of Object.entries(classifierDescriptors)) {
		if (name.length < 1 || name.length > MAX_IDENTIFIER_LENGTH || !descriptor.enumerable || !('value' in descriptor)) throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid classifiers')
		const value = descriptor.value
		if (typeof value !== 'function') throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid classifier')
		classifiers.set(name, value)
	}
	const policies = createPolicyRegistry(mergeBuiltinPolicies(options.policies), new Set(classifiers.keys()), options.fallbackStage?.names)
	let observing = false
	const observe = <T>(callback: () => T): T | undefined => {
		if (observing) return undefined
		observing = true
		try {
			const result = callback()
			isolateUnexpectedThenable(result)
			return result
		} catch { return undefined }
		finally { observing = false }
	}

	let state: ResilienceStatus['state'] = 'running'
	let activeOperations = 0
	let admittedOperations = 0
	let queuedOperations = 0
	let retriedTotal = 0
	let rejectedTotal = 0
	let lastFailureCode: string | undefined
	let shutdownAttempt: Promise<void> | undefined
	let lifecycleDisposer: (() => void) | undefined
	const operationControllers = new Set<AbortController>()
	const acceptedWork = new Set<Promise<void>>()
	const physicalWork = new Set<Promise<void>>()
	const breakers = new Map<string, BreakerState>()
	const bulkheads = new Map<string, BulkheadState>()
	const budgets = new Map<string, RetryBudgetState>()
	const coalesced = new Map<string, CoalescedOperation>()
	const coalescingOwnership = new AsyncLocalStorage<CoalescingOwnership>()
	const shutdownOwnership = new AsyncLocalStorage<boolean>()
	const coalescedPartitionCounts = new Map<string, number>()
	const statePartitions = new Set<string>()
	const partitionActivity = new Map<string, number>()
	let partitionMutation = false
	const telemetry: ResilienceTelemetryController = {}

	const metricIncrement = (name: string, labels?: Record<string, string>) => { observe(() => increment?.(name, labels)) }
	const updateGauges = () => {
		observe(() => record?.('_resilience_active_operations', activeOperations))
		observe(() => record?.('_resilience_queued_operations', queuedOperations))
		emitResilienceTelemetry(telemetry, {kind: 'active_operations', count: activeOperations})
		emitResilienceTelemetry(telemetry, {kind: 'queued_operations', count: queuedOperations})
	}
	const reject = (reason: ResilienceRejectionReason) => {
		rejectedTotal++
		metricIncrement('_resilience_rejections_total', {reason})
		emitResilienceTelemetry(telemetry, {kind: 'rejection', reason})
	}
	const partitionKey = (policy: string, context: ResilienceExecutionContext) => [
		fingerprintResilienceIdentity(policy),
		fingerprintResilienceIdentity(context.resource),
		context.tenantId ? fingerprintResilienceIdentity(context.tenantId) : '-',
		context.workspaceId ? fingerprintResilienceIdentity(context.workspaceId) : '-',
		context.userId ? fingerprintResilienceIdentity(context.userId) : '-'
	].join(':')
	const ensurePartition = (key: string) => {
		if (partitionMutation) throw new ResilienceConfigurationError('RESILIENCE_STATE_CAPACITY', 'state capacity')
		partitionMutation = true
		try {
			if (statePartitions.has(key)) {
				statePartitions.delete(key)
				statePartitions.add(key)
				return
			}
			if (statePartitions.size >= MAX_STATE_PARTITIONS) {
				let evicted = false
				let now: number | undefined
				for (const candidate of statePartitions) {
					if ((partitionActivity.get(candidate) ?? 0) > 0 || bulkheads.has(candidate)) continue
					const breaker = breakers.get(candidate)
					const budget = budgets.get(candidate)
					if (breaker?.state === 'closed' && breaker.failuresInWindow > 0) {
						now ??= clock.now()
						if (now < breaker.protectionUntil) continue
					}
					// OPEN and HALF_OPEN entries remain protective even when no request is
					// currently admitted. Evicting either state recreates the resource as
					// CLOSED and bypasses the required, capacity-limited recovery probes.
					if (breaker?.state === 'open' || breaker?.state === 'half-open') continue
					if (budget) {
						now ??= clock.now()
						if (now < budget.expiresAt) continue
					}
					if ((coalescedPartitionCounts.get(candidate) ?? 0) > 0) continue
					breakers.delete(candidate); budgets.delete(candidate); statePartitions.delete(candidate)
					evicted = true
					break
				}
				if (!evicted) throw new ResilienceConfigurationError('RESILIENCE_STATE_CAPACITY', 'state capacity')
			}
			statePartitions.add(key)
		} finally {
			partitionMutation = false
		}
	}
	const releasePartitionIfUnused = (key: string) => {
		if (breakers.has(key) || bulkheads.has(key) || budgets.has(key)) return
		if ((coalescedPartitionCounts.get(key) ?? 0) > 0) return
		statePartitions.delete(key)
	}

	function getBreaker(key: string): BreakerState {
		ensurePartition(key)
		let breaker = breakers.get(key)
		if (!breaker) { breaker = {state: 'closed', generation: 0, openUntil: 0, halfOpenInFlight: 0, halfOpenSuccesses: 0, results: [], resultsHead: 0, failuresInWindow: 0, protectionUntil: 0}; breakers.set(key, breaker) }
		return breaker
	}

	function admitBreaker(policy: ResiliencePolicyDefinition, key: string, context: ResilienceExecutionContext): number | undefined {
		if (!policy.circuitBreaker) return undefined
		const breaker = getBreaker(key)
		if (breaker.generation < 0) { reject('breaker_open'); throw new BreakerOpenError(context, breaker.openUntil) }
		if (breaker.state === 'open') {
			const generation = breaker.generation
			const now = clock.now()
			if (breaker.state === 'open' && breaker.generation === generation) {
				if (now < breaker.openUntil) { reject('breaker_open'); throw new BreakerOpenError(context, now) }
				breaker.state = 'half-open'; breaker.generation++; breaker.halfOpenInFlight = 0; breaker.halfOpenSuccesses = 0
			}
		}
		if (breaker.state === 'open') {
			reject('breaker_open')
			throw new BreakerOpenError(context, clock.now())
		}
		if (breaker.state === 'half-open') {
			if (breaker.halfOpenInFlight >= policy.circuitBreaker.halfOpenMaxAttempts) { reject('breaker_open'); throw new BreakerOpenError(context, clock.now()) }
			breaker.halfOpenInFlight++
		}
		return breaker.generation
	}

	function cancelBreakerAdmission(policy: ResiliencePolicyDefinition, key: string, generation?: number): void {
		if (!policy.circuitBreaker || generation === undefined) return
		const breaker = breakers.get(key)
		if (breaker?.state === 'half-open' && breaker.generation === generation) breaker.halfOpenInFlight = Math.max(0, breaker.halfOpenInFlight - 1)
	}

	function recordBreaker(policy: ResiliencePolicyDefinition, key: string, failed: boolean, generation?: number): void {
		if (!policy.circuitBreaker || generation === undefined) return
		const breaker = getBreaker(key)
		if (breaker.generation !== generation || breaker.state === 'open') return
		breaker.generation = -1
		if (breaker.state === 'half-open') {
			breaker.halfOpenInFlight = Math.max(0, breaker.halfOpenInFlight - 1)
			if (failed) {
				let openedAt: number
				try { openedAt = clock.now() } catch { openedAt = Number.MAX_SAFE_INTEGER }
				breaker.state = 'open'; breaker.generation = generation + 1
				breaker.openUntil = Math.min(Number.MAX_SAFE_INTEGER, openedAt + policy.circuitBreaker.halfOpenAfterMs)
				breaker.halfOpenSuccesses = 0
			}
			else if (++breaker.halfOpenSuccesses >= policy.circuitBreaker.halfOpenMaxAttempts) { breaker.state = 'closed'; breaker.generation = generation + 1; breaker.results = []; breaker.resultsHead = 0; breaker.failuresInWindow = 0; breaker.protectionUntil = 0; breaker.halfOpenSuccesses = 0 }
			else breaker.generation = generation
			return
		}
		let now: number
		try { now = clock.now() } catch {
			// Result accounting without a trustworthy timestamp cannot safely retain a
			// CLOSED window. Open indefinitely instead of losing failure evidence or
			// allowing a successful completion to mask an unknown accounting state.
			breaker.state = 'open'; breaker.generation = generation + 1
			breaker.openUntil = Number.MAX_SAFE_INTEGER
			breaker.results = []; breaker.resultsHead = 0; breaker.failuresInWindow = 0; breaker.protectionUntil = 0
			return
		}
		const cutoff = now - policy.circuitBreaker.timeWindowMs
		while (breaker.resultsHead < breaker.results.length && breaker.results[breaker.resultsHead]!.at < cutoff) {
			if (breaker.results[breaker.resultsHead]!.failed) breaker.failuresInWindow--
			breaker.resultsHead++
		}
		if (breaker.results.length - breaker.resultsHead >= MAX_BREAKER_RESULTS) {
			if (breaker.results[breaker.resultsHead]!.failed) breaker.failuresInWindow--
			breaker.resultsHead++
		}
		breaker.results.push({at: now, failed})
		if (failed) {
			breaker.failuresInWindow++
			breaker.protectionUntil = Math.min(Number.MAX_SAFE_INTEGER, now + policy.circuitBreaker.timeWindowMs)
		}
		if (breaker.resultsHead >= 64) {
			breaker.results = breaker.results.slice(breaker.resultsHead)
			breaker.resultsHead = 0
		}
		const sampleCount = breaker.results.length - breaker.resultsHead
		if (breaker.failuresInWindow >= policy.circuitBreaker.failureCountThreshold && breaker.failuresInWindow / sampleCount >= policy.circuitBreaker.failureRatioThreshold) {
			breaker.state = 'open'; breaker.generation = generation + 1
			breaker.openUntil = Math.min(Number.MAX_SAFE_INTEGER, now + policy.circuitBreaker.halfOpenAfterMs)
			breaker.results = []; breaker.resultsHead = 0; breaker.failuresInWindow = 0; breaker.protectionUntil = 0
		} else breaker.generation = generation
	}

	async function acquireBulkhead(policy: ResiliencePolicyDefinition, key: string, signal: AbortSignal, context: ResilienceExecutionContext): Promise<readonly [release: () => void, waited: boolean]> {
		if (!policy.bulkhead) return [() => undefined, false]
		if (signal.aborted) throw abortError()
		ensurePartition(key)
		let bucket = bulkheads.get(key)
		if (!bucket) { bucket = {active: 0, queue: []}; bulkheads.set(key, bucket) }
		const release = () => {
			const waiter = bucket!.queue.shift()
			if (waiter) { clearTimer(waiter.timer); waiter.signal.removeEventListener('abort', waiter.onAbort); queuedOperations--; updateGauges(); waiter.resolve() }
			else {
				bucket!.active = Math.max(0, bucket!.active - 1)
				if (bucket!.active === 0) { bulkheads.delete(key); releasePartitionIfUnused(key) }
			}
		}
		if (bucket.active < policy.bulkhead.maxConcurrent) { bucket.active++; return [release, false] }
		if (bucket.queue.length >= policy.bulkhead.maxQueueSize) { reject('bulkhead_overflow'); throw new BulkheadOverflowError(context, clock.now()) }
		await new Promise<void>((resolve, rejectPromise) => {
			const waiter = {} as BulkheadWaiter
			let settled = false
			waiter.signal = signal
			waiter.resolve = resolve
			waiter.reject = rejectPromise
			const remove = () => { const index = bucket!.queue.indexOf(waiter); if (index >= 0) { bucket!.queue.splice(index, 1); queuedOperations--; updateGauges() } }
			waiter.onAbort = () => { if (settled) return; settled = true; remove(); clearTimer(waiter.timer); rejectPromise(abortError()) }
			queuedOperations++; updateGauges()
			bucket!.queue.push(waiter)
			try {
				waiter.timer = setTimeout(() => {
					if (settled) return
					settled = true; remove()
					reject('bulkhead_timeout')
					let timestamp: number
					try { timestamp = clock.now() } catch { timestamp = Number.MAX_SAFE_INTEGER }
					rejectPromise(new BulkheadOverflowError(context, timestamp))
				}, (policy.bulkhead as Exclude<typeof policy.bulkhead, false | undefined>).queueTimeoutMs)
			} catch(error) {
				if (!settled) { settled = true; remove(); rejectPromise(error) }
				return
			}
			if (settled) return
			signal.addEventListener('abort', waiter.onAbort, {once: true})
			// An already-aborted signal does not dispatch to listeners added later.
			// Recheck after publishing the waiter so cancellation cannot strand it.
			if (signal.aborted) waiter.onAbort()
		})
		return [release, true]
	}

	function consumeBudget(policy: ResiliencePolicyDefinition, key: string): boolean {
		if (!policy.retry || !policy.retry.budget) return true
		ensurePartition(key)
		let budget = budgets.get(key)
		if (!budget || clock.now() - budget.windowStartedAt >= policy.retry.budget.windowMs) {
			const windowStartedAt = clock.now()
			budget = {
				remaining: policy.retry.budget.maxRetries,
				windowStartedAt,
				expiresAt: Math.min(Number.MAX_SAFE_INTEGER, windowStartedAt + policy.retry.budget.windowMs)
			}
			budgets.set(key, budget)
		}
		if (budget.remaining < 1) return false
		budget.remaining--
		return true
	}

	async function wait(ms: number, signal: AbortSignal): Promise<void> {
		if (ms <= 0) return
		if (signal.aborted) throw abortError()
		await new Promise<void>((resolve, rejectPromise) => {
			let settled = false
			let timer: ReturnType<typeof setTimeout> | undefined
			const onAbort = () => { if (settled) return; settled = true; clearTimer(timer); signal.removeEventListener('abort', onAbort); rejectPromise(abortError()) }
			try { timer = setTimeout(() => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); resolve() }, ms) }
			catch(error) { rejectPromise(error); return }
			if (settled) return
			signal.addEventListener('abort', onAbort, {once: true})
			if (signal.aborted) onAbort()
		})
	}

	function physical<T>(fn: () => Promise<T>, signal: AbortSignal, ownedWork: Set<Promise<void>>): Promise<T> {
		if (signal.aborted) return Promise.reject(abortError())
		const pending = Promise.resolve().then(() => {
			if (signal.aborted) throw abortError()
			return fn()
		})
		const settlement = pending.then(() => undefined, () => undefined)
		physicalWork.add(settlement)
		ownedWork.add(settlement)
		void settlement.finally(() => {
			physicalWork.delete(settlement)
			ownedWork.delete(settlement)
		})
		return Promise.race([pending, new Promise<never>((_, rejectPromise) => {
			const onAbort = () => { signal.removeEventListener('abort', onAbort); rejectPromise(abortError()) }
			signal.addEventListener('abort', onAbort, {once: true})
			void settlement.finally(() => signal.removeEventListener('abort', onAbort))
		})])
	}

	async function awaitShared<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		if (signal.aborted) throw abortError()
		return await Promise.race([promise, new Promise<never>((_, rejectPromise) => {
			const onAbort = () => { signal.removeEventListener('abort', onAbort); rejectPromise(abortError()) }
			signal.addEventListener('abort', onAbort, {once: true})
			void promise.then(() => signal.removeEventListener('abort', onAbort), () => signal.removeEventListener('abort', onAbort))
		})])
	}

	async function invokeWithRetry<T>(policy: ResiliencePolicyDefinition, context: ResilienceExecutionContext, signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>, key: string, deadlineAt: number, ownedWork: Set<Promise<void>>, onRetry?: (attempt: number, delayMs: number) => void): Promise<T> {
		let attempt = 0
		const retryDeadlineAt = policy.retry ? Math.min(deadlineAt, clock.now() + policy.retry.maxTotalTimeMs) : deadlineAt
		while (true) {
			attempt++
			try { return await physical(() => fn(signal), signal, ownedWork) } catch(error) {
				if (signal.aborted || !policy.retry || clock.now() >= retryDeadlineAt) throw error
				if (attempt >= policy.retry.maxAttempts) throw attempt > 1 ? new RetryExhaustedError(context, error, clock.now()) : error
				let classification: ResilienceClassificationResult
				try {
					const classifier = classifiers.get(policy.retry.classifier)
					if (classifier) {
						const candidate = classifier(error)
						isolateUnexpectedThenable(candidate)
						classification = snapshotClassification(candidate)
					} else classification = classifyBuiltinResilienceError(policy.retry.classifier as never, error, clock.now())
				} catch { classification = {retryable: false} }
				if (!classification.retryable || classification.ambiguousCompletion || !consumeBudget(policy, key)) throw error
				const exponential = Math.min(policy.retry.maxDelayMs, policy.retry.initialDelayMs * policy.retry.multiplier ** (attempt - 1))
				let random = 0
				try {
					const candidate = Math.random()
					isolateUnexpectedThenable(candidate)
					if (Number.isFinite(candidate)) random = Math.min(1, Math.max(0, candidate))
				} catch { /* use deterministic zero jitter */ }
				const jittered = policy.retry.jitter === 'full' ? exponential * random : policy.retry.jitter === 'equal' ? exponential / 2 + exponential / 2 * random : exponential
				const delay = Math.min(policy.retry.maxDelayMs, classification.delayMs ?? jittered, Math.max(0, retryDeadlineAt - clock.now()))
				if (delay <= 0) throw error
				retriedTotal++; metricIncrement('_resilience_retries_total')
				emitResilienceTelemetry(telemetry, {kind: 'retry', attempt})
				try { onRetry?.(attempt, delay) } catch { /* isolated */ }
				await wait(delay, signal)
			}
		}
	}

	async function runFallback<T>(policy: ResiliencePolicyDefinition, error: unknown, signal: AbortSignal, ownedWork: Set<Promise<void>>): Promise<T> {
		if (!policy.fallback || !options.fallbackStage) throw error
		return await options.fallbackStage.run<T>(policy.fallback, error, signal, async(operation, operationSignal) => await physical(operation, operationSignal, ownedWork))
	}

	async function logicalOperation<T>(policy: ResiliencePolicyDefinition, context: ResilienceExecutionContext, signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>, deadlineAt: number, ownedWork: Set<Promise<void>>, onRetry?: (attempt: number, delayMs: number) => void): Promise<T> {
		const key = partitionKey(policy.name, context)
		partitionActivity.set(key, (partitionActivity.get(key) ?? 0) + 1)
		try {
			let breakerGeneration: number | undefined
			try { breakerGeneration = admitBreaker(policy, key, context) }
			catch(error) {
				if (signal.aborted) throw error
				if (finalErrorIdentity(error).code !== 'RESILIENCE_BREAKER_OPEN') throw error
				return await runFallback<T>(policy, error, signal, ownedWork)
			}
			let acquisition: readonly [release: () => void, waited: boolean]
			try { acquisition = await acquireBulkhead(policy, key, signal, context) }
			catch(error) {
				cancelBreakerAdmission(policy, key, breakerGeneration)
				if (signal.aborted) throw error
				if (finalErrorIdentity(error).code !== 'RESILIENCE_BULKHEAD_OVERFLOW') throw error
				return await runFallback<T>(policy, error, signal, ownedWork)
			}
			const [release, waited] = acquisition
			if (waited) {
				cancelBreakerAdmission(policy, key, breakerGeneration)
				if (signal.aborted) { release(); throw abortError() }
				try { breakerGeneration = admitBreaker(policy, key, context) }
				catch(error) {
					release()
					if (signal.aborted) throw error
					if (finalErrorIdentity(error).code !== 'RESILIENCE_BREAKER_OPEN') throw error
					return await runFallback<T>(policy, error, signal, ownedWork)
				}
			}
			try {
				try { const result = await invokeWithRetry(policy, context, signal, fn, key, deadlineAt, ownedWork, onRetry); recordBreaker(policy, key, false, breakerGeneration); return result }
				catch(error) {
					if (signal.aborted) {
						if (finalErrorIdentity(signal.reason).code === 'RESILIENCE_TIMEOUT') recordBreaker(policy, key, true, breakerGeneration)
						throw error
					}
					// Configuration and internal-capacity failures are control-plane
					// decisions, not provider failures eligible for degradation.
					if (finalErrorIdentity(error).kind === 'ResilienceConfigurationError') throw error
					recordBreaker(policy, key, true, breakerGeneration)
					return await runFallback<T>(policy, error, signal, ownedWork)
				}
			} finally {
				const pending = Promise.all([...ownedWork]).then(() => undefined)
				void pending.finally(release)
			}
		} finally {
			const remaining = (partitionActivity.get(key) ?? 1) - 1
			if (remaining > 0) partitionActivity.set(key, remaining)
			else partitionActivity.delete(key)
		}
	}

	function reportFinal(error: unknown, request: ResilienceExecutionRequest): void {
		observe(() => report?.({...finalErrorIdentity(error), message: 'Resilience operation failed'}, {service: 'resilience', operation: sanitizeResilienceOperationName(request.operation), resource: fingerprintResilienceValue(request.context.resource)}))
	}

	async function execute<T>(rawRequest: ResilienceExecutionRequest, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (state !== 'running') { reject('runtime_closed'); throw new ResilienceConfigurationError('RESILIENCE_NOT_RUNNING', 'runtime closed') }
		if (typeof fn !== 'function') throw new ResilienceConfigurationError('RESILIENCE_INVALID_REQUEST', 'invalid callback')
		const request = snapshotRequest(rawRequest)
		const policy = policies.get(request.policy)
		if (!policy) throw new ResilienceConfigurationError('RESILIENCE_UNKNOWN_POLICY', 'unknown policy')
		if (request.coalescingKey && !policy.coalescing) throw new ResilienceConfigurationError('RESILIENCE_COALESCING_DISABLED', 'coalescing disabled')
		const timeoutMs = request.timeoutMs ?? policy.timeout.defaultMs
		const maxMs = policy.timeout.maxMs ?? policy.timeout.defaultMs
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxMs) throw new ResilienceConfigurationError('RESILIENCE_INVALID_TIMEOUT', 'invalid timeout')
		// maxTotalTimeMs is a hard ceiling for the complete retry sequence,
		// including the initial physical attempt, not merely a retry-admission check.
		const executionTimeoutMs = policy.retry
			? Math.min(timeoutMs, policy.retry.maxTotalTimeMs)
			: timeoutMs
		if (admittedOperations >= MAX_ACTIVE_OPERATIONS) {
			reject('admission_capacity')
			throw new ResilienceConfigurationError('RESILIENCE_ADMISSION_CAPACITY', 'admission capacity')
		}
		const startedAt = clock.now()
		// Request snapshots and clock capabilities are re-entrant application
		// boundaries. Shutdown may have completed while either was running; fence
		// admission again before publishing controller and operation ownership.
		if (state !== 'running') {
			reject('runtime_closed')
			throw new ResilienceConfigurationError('RESILIENCE_NOT_RUNNING', 'runtime closed')
		}
		if (admittedOperations >= MAX_ACTIVE_OPERATIONS) {
			reject('admission_capacity')
			throw new ResilienceConfigurationError('RESILIENCE_ADMISSION_CAPACITY', 'admission capacity')
		}
		const controller = createSafeAbortController()
		let timeoutFailure: TimedOutError | undefined
		let resolveAccepted!: () => void
		const acceptedSettlement = new Promise<void>((resolve) => { resolveAccepted = resolve })
		operationControllers.add(controller)
		acceptedWork.add(acceptedSettlement)
		activeOperations++; admittedOperations++; updateGauges()
		const ownedWork = new Set<Promise<void>>()
		let timer: ReturnType<typeof setTimeout>
		try {
			timer = setTimeout(() => {
				let timestamp: number
				try { timestamp = clock.now() } catch { timestamp = startedAt + executionTimeoutMs }
				controller.abort(timeoutFailure = new TimedOutError(request.context, executionTimeoutMs, timestamp))
			}, executionTimeoutMs)
		} catch(error) {
			acceptedWork.delete(acceptedSettlement)
			resolveAccepted()
			operationControllers.delete(controller)
			activeOperations--; admittedOperations--; updateGauges()
			throw error
		}
		const deadlineAt = startedAt + executionTimeoutMs
		const safeOperation = sanitizeResilienceOperationName(request.operation)
		const warnPerformance = () => { observe(() => warn?.('resilience.performance_bridge_failed', {operation: safeOperation})) }
		const span: TracingSpan | undefined = observe(() => startSpan?.(`resilience.${safeOperation}`, {kind: 'internal', attributes: {operation: policy.operationKind, resource: fingerprintResilienceValue(request.context.resource)}}))
		const invoke = async() => {
			const runOwner = async() => {
				try {
					return await logicalOperation(policy, request.context, controller.signal, fn, deadlineAt, ownedWork, (attempt, delayMs) => {
						observe(() => span?.addEvent('resilience.retry', {attempt, delayMs}))
					})
				} catch(error) {
					if (timeoutFailure && controller.signal.reason === timeoutFailure) throw timeoutFailure
					throw error
				}
			}
			if (!request.coalescingKey) return await runOwner()
			const coalescing = policy.coalescing
			if (!coalescing) throw new ResilienceConfigurationError('RESILIENCE_COALESCING_DISABLED', 'coalescing disabled')
			const partition = partitionKey(policy.name, request.context)
			const key = `${partition}:${fingerprintResilienceIdentity(request.operation)}:${fingerprintResilienceIdentity(request.coalescingKey)}`
			const existing = coalesced.get(key)
			if (existing) {
				let owner = coalescingOwnership.getStore()
				while (owner && owner[0] !== key) owner = owner[1]
				if (owner) {
					throw new ResilienceConfigurationError('RESILIENCE_CYCLE', 'cycle')
				}
				if (clock.now() - existing[1] > coalescing.ttlMs) {
					reject('coalescing_expired')
					throw new ResilienceConfigurationError('RESILIENCE_COALESCING_EXPIRED', 'coalescing unavailable')
				}
				if (existing[2] >= MAX_COALESCED_FOLLOWERS) {
					reject('coalescing_capacity')
					throw new ResilienceConfigurationError('RESILIENCE_COALESCING_CAPACITY', 'coalescing unavailable')
				}
				existing[2]++
				try { return deepFreezeClone(await awaitShared(existing[0], controller.signal)) as T }
				finally { existing[2]-- }
			}
			const partitionKeys = coalescedPartitionCounts.get(partition) ?? 0
			if (partitionKeys >= coalescing.maxKeys) { reject('coalescing_capacity'); throw new ResilienceConfigurationError('RESILIENCE_COALESCING_CAPACITY', 'coalescing unavailable') }
			ensurePartition(partition)
			// Capture every fallible claim field before physical work can start. A
			// failed clock must not leave an unclaimed owner running in the background.
			let createdAt: number
			try { createdAt = clock.now() }
			catch(error) { releasePartitionIfUnused(partition); throw error }
			const currentPartitionKeys = coalescedPartitionCounts.get(partition) ?? 0
			if (currentPartitionKeys >= coalescing.maxKeys) {
				releasePartitionIfUnused(partition)
				reject('coalescing_capacity')
				throw new ResilienceConfigurationError('RESILIENCE_COALESCING_CAPACITY', 'coalescing unavailable')
			}
			const ownership: CoalescingOwnership = [key, coalescingOwnership.getStore()]
			const owner = Promise.resolve().then(() => coalescingOwnership.run(ownership, runOwner))
			coalesced.set(key, [owner, createdAt, 0])
			coalescedPartitionCounts.set(partition, currentPartitionKeys + 1)
			const ownerSettlement = owner.then(() => undefined, () => undefined)
			void ownerSettlement.then(async() => await Promise.all([...ownedWork])).finally(() => {
				coalesced.delete(key)
				const remainingKeys = (coalescedPartitionCounts.get(partition) ?? 1) - 1
				if (remainingKeys > 0) coalescedPartitionCounts.set(partition, remainingKeys)
				else coalescedPartitionCounts.delete(partition)
				releasePartitionIfUnused(partition)
			})
			return deepFreezeClone(await owner)
		}
		let once: Promise<T> | undefined
		const invokeOnce = () => once ??= invoke()
		const work = (async() => {
			try {
				let result: T
				if (measureAsync) {
					let measurementOpen = true
					const measuredInvoke = () => {
						if (measurementOpen) return invokeOnce()
						const inactive = Promise.reject<T>(new ResilienceConfigurationError(
							'RESILIENCE_NOT_RUNNING',
							'inactive callback'
						))
						// A retained diagnostic callback may be invoked without its return
						// value being observed. Preserve its rejection contract without
						// allowing that observer bug to reach the host process.
						void inactive.catch(() => undefined)
						return inactive
					}
					try {
						isolateUnexpectedThenable(measureAsync(`resilience.${safeOperation}`, measuredInvoke, {kind: policy.operationKind}), warnPerformance)
					} catch { warnPerformance() }
					try { result = await invokeOnce() } finally { measurementOpen = false }
				} else result = await invokeOnce()
				observe(() => span?.setStatus({code: 'ok'}))
				metricIncrement('_resilience_executions_total', {result: 'success', kind: policy.operationKind})
				emitResilienceTelemetry(telemetry, {kind: 'execution', result: 'success'})
				return result
			} catch(error) {
				const failure = timeoutFailure && controller.signal.reason === timeoutFailure ? timeoutFailure : error
				observe(() => span?.recordException(new Error('Resilience operation failed')))
				observe(() => span?.setStatus({code: 'error'}))
				observe(() => warn?.('resilience.operation_failed', {operation: safeOperation, resource: fingerprintResilienceValue(request.context.resource)}))
				metricIncrement('_resilience_executions_total', {result: 'failure', kind: policy.operationKind})
				emitResilienceTelemetry(telemetry, {kind: 'execution', result: 'failure'})
				reportFinal(failure, request)
				throw failure
			} finally {
				observe(() => span?.end())
			}
		})()
		const settlement = work.then(() => undefined, () => undefined)
		void settlement.finally(() => {
			acceptedWork.delete(acceptedSettlement)
			resolveAccepted()
			clearTimer(timer)
			operationControllers.delete(controller)
			activeOperations--
			updateGauges()
		})
		void settlement.then(async() => await Promise.all([...ownedWork])).finally(() => { admittedOperations-- })
		return await work
	}

	async function awaitShutdownWork(promise: Promise<unknown>, timeout: Promise<never>): Promise<void> {
		await Promise.race([promise, timeout])
	}

	async function boundedDrain(timeout: Promise<never>): Promise<void> {
		while (acceptedWork.size > 0 || physicalWork.size > 0) {
			await awaitShutdownWork(Promise.all([...acceptedWork, ...physicalWork]), timeout)
		}
	}

	async function shutdown(): Promise<void> {
		if (state === 'closed') return
		if (shutdownAttempt) {
			if (shutdownOwnership.getStore()) return
			return await shutdownAttempt
		}
		state = 'draining'
		let shutdownTimer: ReturnType<typeof setTimeout> | undefined
		let rejectTimeout!: (error: Error) => void
		const timeout = new Promise<never>((_, rejectPromise) => { rejectTimeout = rejectPromise })
		// Empty shutdowns may not need to race this promise. Keep a defensive
		// rejection observer in case a hostile timer implementation ignores clear.
		void timeout.catch(() => undefined)
		let beginDrain!: () => void
		const start = new Promise<void>((resolve) => { beginDrain = resolve })
		// Publish before timer scheduling and abort dispatch. Both may synchronously
		// reenter shutdown and must join this exact drain.
		shutdownAttempt = start.then(async() => {
			try {
				for (const controller of operationControllers) controller.abort(abortError())
				for (const bucket of bulkheads.values()) for (const waiter of [...bucket.queue]) waiter.onAbort()
				await boundedDrain(timeout)
				breakers.clear(); bulkheads.clear(); budgets.clear(); coalesced.clear(); coalescedPartitionCounts.clear(); statePartitions.clear(); partitionActivity.clear()
				if (lifecycleDisposer) {
					const disposer = lifecycleDisposer
					lifecycleDisposer = undefined
					try {
						const disposal = shutdownOwnership.run(true, () => captureNativePromise(disposer()) ?? Promise.resolve())
						await awaitShutdownWork(disposal, timeout)
					} catch(error) {
						lifecycleDisposer = disposer
						throw error
					}
				}
				state = 'closed'; lastFailureCode = undefined
			} catch(error) {
				lastFailureCode = 'RESILIENCE_FINALIZATION_FAILURE'
				metricIncrement('_resilience_finalization_failures_total', {operation: 'shutdown'})
				emitResilienceTelemetry(telemetry, {
					kind: 'finalization_failed',
					operation: 'shutdown',
					code: 'RESILIENCE_FINALIZATION_FAILURE'
				})
				throw error
			} finally {
				clearTimer(shutdownTimer)
				shutdownAttempt = undefined
			}
		})
		try {
			shutdownTimer = setTimeout(
				() => rejectTimeout(new Error('Resilience shutdown timed out')),
				SHUTDOWN_TIMEOUT_MS
			)
		} catch(error) {
			rejectTimeout(error instanceof Error ? error : new Error('Resilience shutdown timer failed'))
		}
		beginDrain()
		return await shutdownAttempt
	}

	if (registerShutdownHook) {
		const disposer = observe(() => registerShutdownHook('runtime-monitors', shutdown, {name: 'resilience-cleanup', priority: 20}))
		if (typeof disposer !== 'function') throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'invalid lifecycle disposer')
		lifecycleDisposer = disposer
		// A lifecycle implementation may invoke the hook while registering it.
		// Never publish a runtime whose shutdown began before construction finished;
		// the already-published shutdown attempt retains ownership of the disposer.
		if (state !== 'running') {
			throw new ResilienceConfigurationError('RESILIENCE_INVALID_CONFIG', 'lifecycle shutdown during bootstrap')
		}
	}

	const runtime: ManagedResilience = Object.freeze({
		execute,
		getStatus: () => Object.freeze({state, activeOperations, queuedOperations, retriedTotal, rejectedTotal, ...(lastFailureCode ? {lastFailureCode} : {})}),
		shutdown
	})
	registerResilienceTelemetryTarget(runtime, telemetry)
	return runtime
}
