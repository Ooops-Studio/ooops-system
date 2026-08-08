import type {
	DBQueryMetadata,
	HttpPerfMetadata,
	PerfEvent
} from '@ooopsstudio/core/contracts/performance'

import {snapshotPerformanceLabels} from '../../utils/safe-identifiers'
import {hasSafeRuntimePrototype, isRuntimeProxy} from '../../utils/safe-object'
import {nsToMs, type HighResClock} from '../clock'
import {snapshotSafeDBMetadata} from '../utils/event-helpers'
import {
	buildHttpLabels,
	normalizeHttpMetadata
} from '../utils/request-helpers'

export interface MeasurementPortDependencies {
	clock: HighResClock;
	emitEvent: (event: PerfEvent, metadata?: DBQueryMetadata) => void;
	onError: (error: unknown, context?: Record<string, string>) => void;
	withFailedDBMetadata: (metadata?: DBQueryMetadata) => DBQueryMetadata;
}

const safeContextValue = (value: unknown): string => {
	if (typeof value === 'string') return value.slice(0, 128)
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return '<invalid>'
}

const snapshotResponseStatus = (value: unknown): number | undefined => {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value)) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'status')
		if (descriptor && 'value' in descriptor) {
			return typeof descriptor.value === 'number' ? descriptor.value : undefined
		}
		if (typeof Response === 'undefined' || !hasSafeRuntimePrototype(value, Response.prototype)) return undefined
		const getter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get
		const status = typeof getter === 'function' ? Reflect.apply(getter, value, []) : undefined
		return typeof status === 'number' ? status : undefined
	} catch { return undefined }
}

const mergeHttpMetadata = (
	metadata: HttpPerfMetadata,
	additions: Partial<HttpPerfMetadata>
): HttpPerfMetadata => {
	try { return {...metadata, ...additions} } catch {
		return {method: 'UNKNOWN', route: '/', ...additions}
	}
}

export function createMeasurementPortMethods(
	deps: MeasurementPortDependencies
) {
	const {clock, emitEvent, onError, withFailedDBMetadata} = deps
	const invalidLabels = Object.freeze({'': ''}) as Record<string, string>
	const captureLabels = (labels?: Record<string, string>): Record<string, string> | undefined => {
		try { return snapshotPerformanceLabels(labels) } catch { return invalidLabels }
	}
	const recordRequest = (
		name: string,
		duration: number,
		metadata: HttpPerfMetadata,
		labels?: Record<string, string>
	): void => {
		try {
			const capturedLabels = captureLabels(labels)
			const http = normalizeHttpMetadata(metadata)
			const end = clock.now()
			emitEvent({
				name,
				duration,
				start: end - duration,
				end,
				source: 'mark',
				http,
				labels: buildHttpLabels(http, capturedLabels),
				...(http.outcome ? {outcome: http.outcome} : {})
			})
		} catch(error) {
			onError(error, {measureName: safeContextValue(name), operation: 'record-request'})
		}
	}
	const timedEvent = (
		name: string,
		start: number,
		startHr: bigint,
		labels?: Record<string, string>,
		failed = false
	): PerfEvent => ({
		name,
		duration: nsToMs(clock.nowHr() - startHr),
		start,
		end: Math.max(start, clock.now()),
		source: 'mark',
		...(labels ? {labels} : {}),
		...(failed ? {outcome: 'server_error' as const} : {})
	})

	return {
		measureSync<T>(name: string, fn: () => T, labels?: Record<string, string>): T {
			const start = clock.now()
			const startHr = clock.nowHr()
			const capturedLabels = captureLabels(labels)
			try {
				const result = fn()
				emitEvent(timedEvent(name, start, startHr, capturedLabels))
				return result
			} catch(error) {
				emitEvent(timedEvent(name, start, startHr, capturedLabels, true))
				throw error
			}
		},
		measureAsync<T>(
			name: string,
			fn: () => Promise<T>,
			labels?: Record<string, string>
		): Promise<T> {
			const start = clock.now()
			const startHr = clock.nowHr()
			const capturedLabels = captureLabels(labels)
			return Promise.resolve()
				.then(() => fn())
				.then(
					(result) => {
						emitEvent(timedEvent(name, start, startHr, capturedLabels))
						return result
					},
					(error) => {
						emitEvent(timedEvent(name, start, startHr, capturedLabels, true))
						throw error
					}
				)
		},
		measureDBQuery<T>(
			name: string,
			fn: () => Promise<T>,
			metadata?: DBQueryMetadata,
			labels?: Record<string, string>
		): Promise<T> {
			const start = clock.now()
			const startHr = clock.nowHr()
			const capturedLabels = captureLabels(labels)
			const capturedMetadata = snapshotSafeDBMetadata(metadata)
			return Promise.resolve()
				.then(() => fn())
				.then(
					(result) => {
						emitEvent(timedEvent(name, start, startHr, capturedLabels), capturedMetadata)
						return result
					},
					(error) => {
						emitEvent(
							timedEvent(name, start, startHr, capturedLabels, true),
							withFailedDBMetadata(capturedMetadata)
						)
						throw error
					}
				)
		},
		measureDBQuerySync<T>(
			name: string,
			fn: () => T,
			metadata?: DBQueryMetadata,
			labels?: Record<string, string>
		): T {
			const start = clock.now()
			const startHr = clock.nowHr()
			const capturedLabels = captureLabels(labels)
			const capturedMetadata = snapshotSafeDBMetadata(metadata)
			try {
				const result = fn()
				emitEvent(timedEvent(name, start, startHr, capturedLabels), capturedMetadata)
				return result
			} catch(error) {
				emitEvent(
					timedEvent(name, start, startHr, capturedLabels, true),
					withFailedDBMetadata(capturedMetadata)
				)
				throw error
			}
		},
		record(
			metric: string,
			value: number,
			labels?: Record<string, string>
		): void {
			const end = clock.now()
			const capturedLabels = captureLabels(labels)
			emitEvent({
				name: metric,
				duration: value,
				start: end - value,
				end,
				source: 'mark',
				...(capturedLabels ? {labels: capturedLabels} : {})
			})
		},
		async measureRequest<T>(
			name: string,
			fn: () => Promise<T>,
			metadata: HttpPerfMetadata,
			labels?: Record<string, string>
		): Promise<T> {
			const startHr = clock.nowHr()
			const capturedLabels = captureLabels(labels)
			let capturedMetadata: HttpPerfMetadata
			try { capturedMetadata = normalizeHttpMetadata(metadata) } catch {
				capturedMetadata = {method: 'UNKNOWN', route: '/'}
			}
			try {
				const result = await fn()
				const statusCode = capturedMetadata.statusCode ?? snapshotResponseStatus(result)
				recordRequest(
					name,
					nsToMs(clock.nowHr() - startHr),
					mergeHttpMetadata(capturedMetadata, statusCode !== undefined ? {statusCode} : {}),
					capturedLabels
				)
				return result
			} catch(error) {
				let outcome: NonNullable<HttpPerfMetadata['outcome']> = 'server_error'
				try {
					if (capturedMetadata.aborted) outcome = 'aborted'
					else if (capturedMetadata.timedOut) outcome = 'timeout'
				} catch {
					// Preserve the business error when optional metadata is malformed.
				}
				recordRequest(
					name,
					nsToMs(clock.nowHr() - startHr),
					mergeHttpMetadata(capturedMetadata, {statusCode: undefined, outcome}),
					capturedLabels
				)
				throw error
			}
		},
		recordRequest
	}
}
