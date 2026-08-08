import {createHash} from 'node:crypto'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {
	BackendErrorPolicy,
	RateLimitBatchDecision,
	RateLimitCheckRequest,
	RateLimitDecision,
	RateLimitPolicyDefinition,
	RateLimitStatus
} from '@ooopsstudio/core/contracts/rate-limit'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {ManagedRateLimit} from '@ooopsstudio/core/ports/ratelimit'

import {
	emitRateLimitTelemetry,
	registerRateLimitTelemetryTarget
} from '../runtime-capabilities'
import type {RateLimitEngine, RateLimitEngineResult} from '../types/engine'
import {ignoreRateLimitPromiseRejection, isRateLimitProxy} from '../utils/safe-object'

import {isRateLimitBackendError} from './backend-error'
import {createRateLimitPolicyRegistry, type RuntimeRateLimitPolicy} from './policy-registry'

const MAX_BATCH_CHECKS = 16
const MAX_KEY_LENGTH = 512
const MAX_PENDING_OPERATIONS = 1_024
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u

class RateLimitOperationTimeoutError extends Error {
	constructor() {
		super('Rate limit backend operation timed out')
		this.name = 'RateLimitOperationTimeoutError'
	}
}

function captureMethod<TArguments extends unknown[], TResult>(
	source: object | undefined,
	name: PropertyKey
): ((...arguments_: TArguments) => TResult) | undefined {
	if (!source || isRateLimitProxy(source)) return undefined
	let current: object | null = source
	try {
		for (let depth = 0; current && depth < 16; depth++) {
			if (isRateLimitProxy(current)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(current, name)
			if (descriptor) {
				if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
				const method = descriptor.value as (...arguments_: TArguments) => TResult
				return (...arguments_: TArguments) => Reflect.apply(method, source, arguments_)
			}
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function bindClock(clock: Clock): Clock {
	const now = captureMethod<[], number>(clock, 'now')
	if (!now) throw new TypeError('Rate limit requires a clock with a data-method now()')
	return Object.freeze({now})
}

function positiveDuration(value: number, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`)
	}
	return value
}

function readNow(clock: Clock): number {
	const now = clock.now()
	if (!Number.isSafeInteger(now) || now < 0) throw new Error('Rate limit clock returned an invalid timestamp')
	return now
}

function safeDeadline(now: number, delay: number): number | null {
	const deadline = now + delay
	return Number.isSafeInteger(deadline) ? deadline : null
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new RateLimitOperationTimeoutError()), timeoutMs)
		promise.then(
			(value) => { clearTimeout(timer); resolve(value) },
			(error: unknown) => { clearTimeout(timer); reject(error) }
		)
	})
}

function hash(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function snapshotRequest(value: unknown): RateLimitCheckRequest {
	if (!value || typeof value !== 'object' || isRateLimitProxy(value) || Array.isArray(value)) throw new TypeError('Rate limit check request must be a plain object')
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const allowed = new Set(['policy', 'key', 'cost'])
		if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		return Object.freeze({
			policy: descriptors.policy?.value as string,
			...(descriptors.key !== undefined ? {key: descriptors.key.value as string} : {}),
			...(descriptors.cost !== undefined ? {cost: descriptors.cost.value as number} : {})
		})
	} catch {
		throw new TypeError('Rate limit check request contains invalid, accessor-backed, or unexpected fields')
	}
}

function freezeDecision(decision: RateLimitDecision): RateLimitDecision {
	return Object.freeze(decision)
}

export interface RateLimitHandlerOptions {
	readonly clock: Clock
	readonly policies: readonly RateLimitPolicyDefinition[]
	readonly backend: 'memory' | 'redis'
	readonly createEngine: (policy: RuntimeRateLimitPolicy, clock: Clock) => RateLimitEngine
	readonly namespace?: string
	readonly onBackendError: BackendErrorPolicy
	readonly operationTimeoutMs?: number
	readonly shutdownTimeoutMs?: number
	readonly lifecycle?: LifecyclePort
}

export function createManagedRateLimit(options: RateLimitHandlerOptions): ManagedRateLimit {
	if (!options || typeof options !== 'object') throw new TypeError('Rate limit options are required')
	const clock = bindClock(options.clock)
	const policies = createRateLimitPolicyRegistry(options.policies)
	const operationTimeoutMs = positiveDuration(options.operationTimeoutMs ?? 1_000, 'Rate limit operationTimeoutMs', 30_000)
	const shutdownTimeoutMs = positiveDuration(options.shutdownTimeoutMs ?? 5_000, 'Rate limit shutdownTimeoutMs', 60_000)
	if (options.onBackendError !== 'allow' && options.onBackendError !== 'block') {
		throw new TypeError('Rate limit onBackendError must be "allow" or "block"')
	}
	if (options.backend !== 'memory' && options.backend !== 'redis') throw new TypeError('Rate limit backend is invalid')
	const namespace = options.namespace ?? 'rate-limit'
	if (!NAMESPACE.test(namespace)) throw new TypeError('Rate limit namespace is invalid')
	const engines = new Map<string, RateLimitEngine>()
	for (const policy of policies.values()) engines.set(policy.name, options.createEngine(policy, clock))

	let state: 'running' | 'draining' | 'closed' = 'running'
	let backendState: 'healthy' | 'degraded' | 'unhealthy' | 'closed' = 'healthy'
	let rejectedTotal = 0
	let backendFailuresTotal = 0
	let lastFailureCode: string | undefined
	const pending = new Set<Promise<unknown>>()
	const telemetry = {}
	let shutdownAttempt: Promise<void> | undefined
	let lifecycleDisposer: (() => void) | undefined

	const emit = (event: Parameters<typeof emitRateLimitTelemetry>[1]): void => {
		emitRateLimitTelemetry(telemetry, event)
	}
	const setBackendFailure = (code: string): void => {
		backendState = 'unhealthy'
		lastFailureCode = code
		backendFailuresTotal++
		emit({kind: 'backend_failed', code})
	}
	const recover = (): void => {
		if (state !== 'running' || backendState === 'healthy') return
		backendState = 'healthy'
		lastFailureCode = undefined
		emit({kind: 'recovered'})
	}
	const storageKey = (policy: RuntimeRateLimitPolicy, key: string | undefined): string =>
		`${namespace}:${hash(policy.fingerprint)}:${policy.partition === 'global' ? 'global' : hash(key!)}`
	const resolve = (request: unknown): {request: RateLimitCheckRequest; policy: RuntimeRateLimitPolicy; cost: number} => {
		const captured = snapshotRequest(request)
		if (typeof captured.policy !== 'string') throw new TypeError('Rate limit policy name is required')
		const policy = policies.get(captured.policy)
		if (!policy) throw new Error(`Unknown rate limit policy: ${captured.policy}`)
		if (policy.partition === 'keyed') {
			if (typeof captured.key !== 'string' || captured.key.trim().length === 0 || captured.key.length > MAX_KEY_LENGTH) {
				throw new TypeError(`Rate limit policy "${policy.name}" requires a valid key`)
			}
		} else if (captured.key !== undefined) throw new TypeError(`Global rate limit policy "${policy.name}" does not accept a key`)
		const cost = captured.cost ?? policy.defaultCost
		if (!Number.isSafeInteger(cost) || cost <= 0 || cost > policy.maxCost) {
			throw new TypeError(`Rate limit policy "${policy.name}" cost is invalid`)
		}
		return {request: captured, policy, cost}
	}
	const fallbackDecision = (policy: RuntimeRateLimitPolicy): RateLimitDecision => {
		const now = readNow(clock)
		const resetAt = policy.algorithm === 'fixed-window'
			? safeDeadline(Math.floor(now / policy.windowMs) * policy.windowMs, policy.windowMs)
			: safeDeadline(now, policy.windowMs)
		const allowed = policy.mode === 'shadow' || options.onBackendError === 'allow'
		return freezeDecision({
			allowed,
			policy: policy.name,
			limit: policy.limit,
			remaining: allowed ? policy.limit : 0,
			resetAt,
			retryAfterMs: allowed || resetAt === null ? null : Math.max(0, resetAt - now),
			reason: 'backend_unavailable'
		})
	}
	const backendFailureDecision = (policy: RuntimeRateLimitPolicy, code: string): RateLimitDecision => {
		setBackendFailure(code)
		const decision = fallbackDecision(policy)
		if (!decision.allowed) {
			rejectedTotal++
			emit({kind: 'rejection', reason: 'backend'})
		}
		emit({kind: 'check', result: decision.allowed ? 'backend_allowed' : 'backend_blocked'})
		return decision
	}
	const project = (policy: RuntimeRateLimitPolicy, result: RateLimitEngineResult): RateLimitDecision => {
		const now = readNow(clock)
		if (!Number.isSafeInteger(result.remaining) || result.remaining < 0 || result.remaining > policy.limit) {
			throw new Error('Rate limit engine returned invalid remaining capacity')
		}
		// Engines validate deadlines against the timestamp captured for their own
		// evaluation. An async backend may legitimately return after that deadline
		// has passed (most visibly at a fixed-window boundary, or when a burst
		// bucket reports an immediate reset). Comparing with a second clock read
		// here would turn a valid, already-consumed Redis decision into an error.
		if (!Number.isSafeInteger(result.resetAt) || result.resetAt < 0) throw new Error('Rate limit engine returned an invalid reset timestamp')
		const retryAt = result.retryAt ?? result.resetAt
		if (!Number.isSafeInteger(retryAt) || retryAt < 0) throw new Error('Rate limit engine returned an invalid retry timestamp')
		const shadow = policy.mode === 'shadow'
		return freezeDecision({
			allowed: shadow || result.allowed,
			policy: policy.name,
			limit: policy.limit,
			remaining: result.remaining,
			resetAt: result.resetAt,
			retryAfterMs: result.allowed || shadow ? null : Math.max(0, retryAt - now),
			reason: shadow ? 'shadow' : result.allowed ? 'allowed' : 'limit_exceeded'
		})
	}

	const check = async(request: RateLimitCheckRequest): Promise<RateLimitDecision> => {
		const resolved = resolve(request)
		if (state !== 'running') {
			rejectedTotal++
			emit({kind: 'rejection', reason: 'closed'})
			throw new Error('RATE_LIMIT_RUNTIME_DRAINING')
		}
		if (pending.size >= MAX_PENDING_OPERATIONS) {
			return backendFailureDecision(resolved.policy, 'RATE_LIMIT_OPERATION_CAPACITY_EXCEEDED')
		}
		const engine = engines.get(resolved.policy.name)!
		// Reserve physical ownership before invoking caller-controlled capabilities.
		// A clock or backend method may reenter check(); without this reservation,
		// every nested call can pass the pending-operation cap before any is tracked.
		const raw = Promise.resolve().then(() => engine.checkAndConsume(
			storageKey(resolved.policy, resolved.request.key),
			resolved.policy.limit,
			resolved.policy.windowMs,
			resolved.cost
		))
		pending.add(raw)
		emit({kind: 'active_operations', count: pending.size})
		let timedOut = false
		void raw.then(
			() => {
				pending.delete(raw)
				emit({kind: 'active_operations', count: pending.size})
				if (timedOut) recover()
			},
			() => {
				pending.delete(raw)
				emit({kind: 'active_operations', count: pending.size})
			}
		)
		try {
			const result = await withTimeout(raw, operationTimeoutMs)
			recover()
			const decision = project(resolved.policy, result)
			if (!result.allowed && resolved.policy.mode !== 'shadow') {
				rejectedTotal++
				emit({kind: 'rejection', reason: 'limit'})
			}
			emit({kind: 'check', result: decision.reason === 'shadow' ? 'shadow' : decision.allowed ? 'allowed' : 'rejected'})
			return decision
		} catch(error) {
			if (!isRateLimitBackendError(error) && !(options.backend === 'redis' && error instanceof RateLimitOperationTimeoutError)) throw error
			timedOut = error instanceof RateLimitOperationTimeoutError
			return backendFailureDecision(resolved.policy, timedOut ? 'RATE_LIMIT_BACKEND_TIMEOUT' : 'RATE_LIMIT_BACKEND_FAILURE')
		}
	}

	const checkMany = async(requests: readonly RateLimitCheckRequest[]): Promise<RateLimitBatchDecision> => {
		if (isRateLimitProxy(requests) || !Array.isArray(requests) || requests.length > MAX_BATCH_CHECKS) {
			throw new TypeError(`Rate limit checkMany accepts an array of at most ${MAX_BATCH_CHECKS} requests`)
		}
		const captured: RateLimitCheckRequest[] = []
		for (let index = 0; index < requests.length; index++) {
			let descriptor: PropertyDescriptor | undefined
			try { descriptor = Object.getOwnPropertyDescriptor(requests, String(index)) } catch { /* rejected below */ }
			if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
				throw new TypeError('Rate limit checkMany requires a dense data-only array')
			}
			captured.push(snapshotRequest(descriptor.value))
		}
		const decisions: RateLimitDecision[] = []
		for (const request of captured) {
			const decision = await check(request)
			decisions.push(decision)
			if (!decision.allowed) return Object.freeze({allowed: false, decisions: Object.freeze(decisions), blockedBy: decision.policy})
		}
		return Object.freeze({allowed: true, decisions: Object.freeze(decisions)})
	}

	const getStatus = (): RateLimitStatus => Object.freeze({
		state,
		backendState: state === 'closed' ? 'closed' : backendState,
		activeOperations: pending.size,
		rejectedTotal,
		backendFailuresTotal,
		...(lastFailureCode ? {lastFailureCode} : {})
	})

	const shutdown = (): Promise<void> => {
		if (state === 'closed') return Promise.resolve()
		if (shutdownAttempt) return shutdownAttempt
		state = 'draining'
		shutdownAttempt = (async() => {
			try {
				await withTimeout(Promise.allSettled([...pending]).then(() => undefined), shutdownTimeoutMs)
				if (lifecycleDisposer) {
					const disposal = lifecycleDisposer()
					ignoreRateLimitPromiseRejection(disposal)
					lifecycleDisposer = undefined
				}
				state = 'closed'
				backendState = 'closed'
				lastFailureCode = undefined
			} catch(error) {
				lastFailureCode = 'RATE_LIMIT_SHUTDOWN_FAILURE'
				backendState = 'unhealthy'
				emit({kind: 'finalization_failed', operation: 'shutdown', code: lastFailureCode})
				throw error
			} finally {
				if (state !== 'closed') shutdownAttempt = undefined
			}
		})()
		return shutdownAttempt
	}

	const runtime: ManagedRateLimit = Object.freeze({check, checkMany, getStatus, shutdown})
	registerRateLimitTelemetryTarget(runtime, telemetry)
	const registerShutdownHook = captureMethod<Parameters<LifecyclePort['registerShutdownHook']>, ReturnType<LifecyclePort['registerShutdownHook']>>(
		options.lifecycle,
		'registerShutdownHook'
	)
	if (options.lifecycle && !registerShutdownHook) throw new TypeError('Rate limit lifecycle capability is invalid')
	if (registerShutdownHook) {
		let lifecycleRegistrationComplete = false
		const registeredShutdown = async(): Promise<void> => {
			if (!lifecycleRegistrationComplete) return
			await shutdown()
		}
		const disposer: unknown = registerShutdownHook('observability', registeredShutdown, {name: 'rate-limit-shutdown', priority: 20})
		if (typeof disposer !== 'function') {
			ignoreRateLimitPromiseRejection(disposer)
			throw new TypeError('Rate limit lifecycle registration must return a disposer function')
		}
		lifecycleDisposer = disposer as () => void
		lifecycleRegistrationComplete = true
	}
	return runtime
}
