import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import type {Logging} from '@ooopsstudio/core/ports/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import type {Tracing} from '@ooopsstudio/core/ports/tracing'
import type {Container} from '@ooopsstudio/core/runtime'
import {
	captureSyncMethod as captureCapability,
	isolateUnexpectedThenable,
	snapshotBoundedDataGraph
} from '@ooopsstudio/core/runtime/async/safe-abort-controller'
import {TOK} from '@ooopsstudio/core/tokens'

import type {ContainerBoundary, ResilienceOptions} from './registration-types'
import {captureClock} from './utils/capabilities'

const registrations = new WeakSet<object>()

function snapshotFields(value: unknown, maximum: number): Record<string, unknown> | undefined {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		const keys = Reflect.ownKeys(value)
		if (keys.length > maximum || keys.some((key) => typeof key !== 'string')) return undefined
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const key of keys as string[]) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable || !('value' in descriptor)) return undefined
			result[key] = descriptor.value
		}
		return result
	} catch { return undefined }
}

function captureContainer(container: Container): ContainerBoundary {
	const has = captureCapability<[symbol], boolean>(container, 'has')
	const get = captureCapability<[symbol], unknown>(container, 'get')
	const tryGet = captureCapability<[symbol], unknown>(container, 'tryGet')
	const bind = captureCapability<[symbol, unknown], unknown>(container, 'bind')
	const unbind = captureCapability<[symbol], unknown>(container, 'unbind')
	if (!has || !get || !tryGet || !bind || !unbind) throw new TypeError('Invalid resilience container')
	return {
		has(token) {
			const result = has(token)
			isolateUnexpectedThenable(result)
			if (typeof result !== 'boolean') throw new TypeError('Container.has must return a boolean')
			return result
		},
		get(token) { const result = get(token); isolateUnexpectedThenable(result); return result },
		tryGet(token) { const result = tryGet(token); isolateUnexpectedThenable(result); return result },
		bind,
		unbind
	}
}

function capturePort(owner: unknown, keys: readonly string[], required = false): Readonly<Record<string, (...args: unknown[]) => unknown>> | undefined {
	const result: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>
	let captured = 0
	for (const key of keys) {
		const method = captureCapability<unknown[], unknown>(owner, key)
		if (method) { result[key] = method; captured++ }
	}
	if (owner !== undefined && required && captured === 0) throw new TypeError('Invalid port')
	return captured > 0 ? Object.freeze(result) : undefined
}

function snapshotRegistration(value: unknown): ResilienceOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid registration options')
	const fields = snapshotFields(value, 2)
	if (!fields || Object.keys(fields).some((key) => !['preset', 'options'].includes(key))) throw new TypeError('unexpected registration fields')
	const preset = fields.preset
	if (typeof preset !== 'string' || !['development', 'production', 'custom'].includes(preset)) throw new TypeError('Unknown resilience preset')
	const rawOptions = fields.options
	if (preset === 'custom' && rawOptions === undefined) throw new TypeError('Custom options required')
	if (rawOptions === undefined) return Object.freeze({preset}) as ResilienceOptions
	if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) throw new TypeError('Invalid preset options')
	const allowedOptions = preset === 'custom' ? new Set(['policies', 'classifiers', 'fallbacks']) : new Set(['policies'])
	const optionFields = snapshotFields(rawOptions, allowedOptions.size)
	if (!optionFields) throw new TypeError('Unsafe resilience preset options')
	if (Object.keys(optionFields).some((key) => !allowedOptions.has(key))) {
		throw new TypeError('Unexpected preset fields')
	}
	let options: Record<string, unknown>
	try { options = snapshotBoundedDataGraph(optionFields) as typeof options }
	catch { throw new TypeError('Unsafe resilience preset options') }
	return Object.freeze({preset, options}) as ResilienceOptions
}

export async function registerResilience(containerValue: Container, optionsValue: ResilienceOptions): Promise<void> {
	if (!containerValue || (typeof containerValue !== 'object' && typeof containerValue !== 'function')) {
		throw new TypeError('Invalid resilience container')
	}
	if (registrations.has(containerValue)) throw new Error('Resilience is already registered')
	registrations.add(containerValue)
	try {
		const config = snapshotRegistration(optionsValue)
		const container = captureContainer(containerValue)
		if (container.has(TOK.Resilience)) throw new Error('Resilience is already registered')
		const clock = captureClock(container.get(TOK.Clock) as Clock)
		const lifecycle = capturePort(container.tryGet(TOK.Lifecycle), ['registerShutdownHook'], true) as LifecyclePort | undefined
		const logger = capturePort(container.tryGet(TOK.Logging), ['warn'], true) as Logging | undefined
		const errors = capturePort(container.tryGet(TOK.Errors), ['report'], true) as Errors | undefined
		const metrics = capturePort(container.tryGet(TOK.Metrics), ['increment', 'record']) as MetricsPort | undefined
		const tracer = capturePort(container.tryGet(TOK.Tracing), ['startSpan'], true) as Tracing | undefined
		const performance = capturePort(container.tryGet(TOK.Performance), ['measureAsync']) as PerformancePort | undefined
		const injected = {clock, ...(logger !== undefined ? {logger} : {}), ...(errors !== undefined ? {errors} : {}), ...(metrics ? {metrics} : {}), ...(tracer !== undefined ? {tracer} : {}), ...(performance ? {performance} : {}), ...(lifecycle !== undefined ? {lifecycle} : {})}
		const {completeResilienceRegistration} = await import('./registration')
		await completeResilienceRegistration(container, config, injected)
	} finally {
		registrations.delete(containerValue)
	}
}

export type {ManagedResilience} from './public/types'
export type {ResilienceOptions} from './registration-types'
export type {
	ResilienceOperationKind,
	ResilienceRetryClassifier,
	ResilienceRuntimeState,
	ResilienceStatus,
	ResilienceExecutionContext,
	ResilienceExecutionRequest,
	ResiliencePolicyDefinition,
	ResilienceErrorClassifier,
	ResilienceClassificationResult,
	FallbackStrategy
} from './public/types'
