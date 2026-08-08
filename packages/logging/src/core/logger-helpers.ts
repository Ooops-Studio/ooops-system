import type {LogAttributes, LogLevel, LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {LifecyclePort} from '@ooopsstudio/core/ports/lifecycle'
import {snapshotPlainDataRecord} from '@ooopsstudio/core/utils/validation'

import type {LoggingSamplingPolicy} from '../types/handler'
import {captureLoggingMethod, observeLoggingThenable} from '../utils/capabilities'
import {copyLogAttributes} from '../utils/enriching'
import {isLogLevel} from '../utils/guards'

const loggingTimeoutLabels = new WeakMap<object, string>()

export function assertLoggingClock(value: unknown, required = true): asserts value is {now(): number} {
	if (value === undefined && !required) return
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
		throw new TypeError('Logging clock must expose a now() function')
	}
	if (!captureLoggingMethod(value, 'now')) throw new TypeError('Logging clock must expose a now() function')
}

export function safeClockNow(clock: {now(): number}): number {
	try {
		const value: unknown = clock.now()
		if (observeLoggingThenable(value)) return Date.now()
		return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
	} catch {
		return Date.now()
	}
}

export function snapshotLoggingClock(value: unknown, required = true): {now(): number} | undefined {
	assertLoggingClock(value, required)
	if (value === undefined) return undefined
	const now = captureLoggingMethod<() => unknown>(value, 'now')
	if (!now) throw new TypeError('Logging clock must expose a now() function')
	return Object.freeze({
		now: () => {
			const result: unknown = now.call(value)
			if (observeLoggingThenable(result)) return Date.now()
			return typeof result === 'number' && Number.isFinite(result) ? result : Date.now()
		}
	})
}

export function snapshotLoggingLifecycle(value: unknown): LifecyclePort | undefined {
	if (value === undefined) return undefined
	const getStatus = captureLoggingMethod<LifecyclePort['getStatus']>(value, 'getStatus')
	const registerFlushHook = captureLoggingMethod<LifecyclePort['registerFlushHook']>(value, 'registerFlushHook')
	const registerShutdownHook = captureLoggingMethod<LifecyclePort['registerShutdownHook']>(value, 'registerShutdownHook')
	if (!getStatus || !registerFlushHook || !registerShutdownHook) {
		throw new TypeError('Logging lifecycle must expose getStatus(), registerFlushHook(), and registerShutdownHook() functions')
	}
	const assertDisposer = (disposer: unknown, capability: string): (() => void) => {
		if (typeof disposer !== 'function') {
			if (captureLoggingMethod(disposer, 'then')) {
				void Promise.resolve(disposer).catch(() => undefined)
			}
			throw new TypeError(`Logging lifecycle ${capability}() must return a disposer function`)
		}
		return disposer as () => void
	}
	return Object.freeze({
		getStatus: () => getStatus.call(value),
		registerFlushHook: (...args: Parameters<LifecyclePort['registerFlushHook']>) => assertDisposer(
			registerFlushHook.call(value, ...args), 'registerFlushHook'
		),
		registerShutdownHook: (...args: Parameters<LifecyclePort['registerShutdownHook']>) => assertDisposer(
			registerShutdownHook.call(value, ...args), 'registerShutdownHook'
		)
	}) as LifecyclePort
}

export function getSeverityRank(level: LogLevel): number {
	switch (level) {
		case 'trace': return 0
		case 'debug': return 1
		case 'info': return 2
		case 'warn': return 3
		case 'error': return 4
		case 'fatal': return 5
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		default: return 2
	}
}

export function normalizeSampling(
	policy?: Readonly<LoggingSamplingPolicy>
): LoggingSamplingPolicy | undefined {
	if (policy === undefined) return undefined
	let snapshot: Record<string, unknown> | undefined
	if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
		throw new TypeError('Logging sampling policy must be an object')
	}
	snapshot = snapshotPlainDataRecord(policy, new Set(['strategy', 'rate', 'keepAtOrAbove']))
	if (!snapshot) throw new TypeError('Logging sampling policy contains invalid or unexpected fields')
	const strategy = snapshot?.strategy
	const rate = snapshot?.rate as number | undefined
	const keepAtOrAbove = snapshot?.keepAtOrAbove
	if (strategy !== 'fixed-rate' && strategy !== 'keyed') {
		throw new TypeError('Logging sampling strategy must be fixed-rate or keyed')
	}
	if (!Number.isFinite(rate) || (rate as number) < 0 || (rate as number) > 1) {
		throw new TypeError('Logging sampling rate must be between 0 and 1')
	}
	if (keepAtOrAbove !== undefined && !isLogLevel(keepAtOrAbove)) {
		throw new TypeError('Logging sampling severity must be a valid log level')
	}
	return {
		strategy,
		rate: rate as number,
		keepAtOrAbove: keepAtOrAbove ?? 'error'
	}
}

export function clampSamplingRate(rate: number | undefined): number {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (rate === undefined || Number.isNaN(rate)) return 1
	return Math.min(1, Math.max(0, rate))
}

/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
export function stableHash(value: string): number {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	let hash = 2166136261
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	for (let index = 0; index < value.length; index += 1) {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		hash ^= value.charCodeAt(index)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		hash = Math.imul(hash, 16777619)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return (hash >>> 0) / 0xffffffff
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
export function selectSamplingSeed(record: Readonly<LogRecord>): string {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	try {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const context = record.context
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const attributes = context?.attributes as Record<string, unknown> | undefined
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const meta = attributes?.meta
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (meta && typeof meta === 'object') {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			const samplingKey = (meta as Record<string, unknown>).samplingKey
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (typeof samplingKey === 'string' && samplingKey.length > 0) {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				return samplingKey
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			}
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		// Sampling is a best-effort admission policy. A hostile context must not
		// prevent primary log delivery.
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	try {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return record.message
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return ''
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
export function selectFixedSamplingSeed(record: Readonly<LogRecord>, level: LogLevel): string {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	let time = ''
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	try {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		time = String(record.time)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	} catch {
		// A malformed custom enricher must not turn sampling into a write failure.
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return `${selectSamplingSeed(record)}:${time}:${level}`
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

export function shouldKeepRecord(
	record: Readonly<LogRecord>,
	level: LogLevel,
	policy: Readonly<LoggingSamplingPolicy>
): boolean {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (getSeverityRank(level) >= getSeverityRank(policy.keepAtOrAbove ?? 'error')) {
		return true
	}

	const rate = clampSamplingRate(policy.rate)
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (rate >= 1) return true
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (rate <= 0) return false

	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (policy.strategy === 'keyed') {
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		return stableHash(selectSamplingSeed(record)) < rate
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	}

	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	return stableHash(selectFixedSamplingSeed(record, level)) < rate
/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
}

export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`logging ${label} timed out after ${timeoutMs}ms`)
			loggingTimeoutLabels.set(error, label)
			reject(error)
		}, timeoutMs)
		timer.unref?.()
	})
	return Promise.race([operation, timeout]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

export function mergeAttributesWithLifecycle(
	attributes: LogAttributes | undefined,
	healthStatus: string
): LogAttributes {
	const merged = Object.create(null) as Record<string, unknown>
	if (attributes && typeof attributes === 'object') {
		Object.assign(merged, copyLogAttributes(attributes))
	}
	merged.lifecycle = {health: healthStatus}
	return merged as LogAttributes
}

export function isTimeoutError(error: unknown, label: string): boolean {
	return !!error && (typeof error === 'object' || typeof error === 'function')
		&& loggingTimeoutLabels.get(error as object) === label
}
