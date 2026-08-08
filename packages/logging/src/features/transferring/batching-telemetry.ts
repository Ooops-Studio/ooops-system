import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {MetricsPort} from '@ooopsstudio/core/ports/metrics'

import type {TransferSignalKind} from '../../types/transferring'
import {reportLogDropped, reportLogRetried, reportLogWritten} from '../../utils/self-metrics'

import {isAmbiguousDeliveryError} from './delivery'

interface TelemetryOptions {
	readonly onMark?: (kind: TransferSignalKind, info?: LogAttributes, size?: number) => void
	readonly onError?: (error: unknown) => void
	readonly selfMetrics?: boolean
	readonly metrics?: MetricsPort
	readonly rememberTerminalFailure: (error: unknown) => void
}

export function createBatchingTelemetry(options: Readonly<TelemetryOptions>) {
	const {onMark, onError, selfMetrics, metrics, rememberTerminalFailure} = options
	return {
		onMark: (event: string, info?: Record<string, unknown>, size?: number) => {
			try {
				onMark?.(event as TransferSignalKind, info as LogAttributes | undefined, size)
				if (event === 'retry' && selfMetrics) reportLogRetried(metrics, {})
			} catch { /* Observer failures must not alter delivery. */ }
		},
		onDropped: (count: number, reason: string) => {
			try {
				const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
				// The shared pipeline emits one aggregate `onMark` before `onDropped`
				// for prepared/aborted records. Fill in only the remaining records for
				// those paths; other drop paths have not been marked yet.
				const alreadyMarked = reason === 'signal-aborted' || reason === 'filtered' ? 1 : 0
				for (let index = alreadyMarked; index < normalizedCount; index += 1) {
					onMark?.('drop', {reason})
				}
				if (selfMetrics) {
					for (let index = 0; index < normalizedCount; index += 1) {
						reportLogDropped(metrics, reason)
					}
				}
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			} catch { /* Observer failures must not alter delivery. */ }
		},
		onError: (error: unknown) => {
			if (isAmbiguousDeliveryError(error)) {
				rememberTerminalFailure(error)
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				try { onError?.(error) } catch { /* Observer failures must not alter delivery. */ }
				return
			}
			rememberTerminalFailure(error)
			try { onError?.(error) } catch { /* Observer failures must not alter delivery. */ }
		},
		onSuccess: (count?: number) => {
			try {
				if (count) for (let index = 0; index < count; index += 1) onMark?.('write')
				if (selfMetrics && count) {
					for (let index = 0; index < count; index += 1) reportLogWritten(metrics)
				}
			} catch { /* Observer failures must not alter delivery. */ }
		}
	}
}
