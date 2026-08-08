/**
 * @file Backpressure handling for log transfer queue.
 */

import {byteSize} from '@ooopsstudio/core/utils/byte-size'

export type BackpressurePolicy = {
	maxQueuedItems: number
	maxQueuedBytes: number
	onOverflow: 'drop-oldest' | 'drop-newest' | 'error'
}

export function enqueueWithBackpressure(
	line: string,
	queue: string[],
	queueSize: {value: number},
	queuedBytes: {value: number},
	policy: BackpressurePolicy,
	front: boolean,
	onMark: (mark: string, data?: Record<string, unknown>) => void,
	onError: (error: unknown) => void
): boolean {
	const lineBytes = byteSize(line)
	const safeMark = (mark: string, data?: Record<string, unknown>): void => {
		try {
			onMark(mark, data)
		} catch {
			// Telemetry callbacks must not alter queue delivery decisions.
		}
	}
	const safeError = (error: unknown): void => {
		try {
			onError(error)
		} catch {
			// Observer failures must not alter queue delivery decisions.
		}
	}

	const commit = (): void => {
		if (front) {
			queue.unshift(line)
		} else {
			queue.push(line)
		}
		queueSize.value = queue.length
		queuedBytes.value += lineBytes
	}

	const evictOldest = (): boolean => {
		if (queue.length === 0) {
			safeMark('drop', {reason: 'backpressure-error'})
			return false
		}

		const dropped = queue.shift()
		if (dropped !== undefined) {
			queuedBytes.value -= byteSize(dropped)
		}
		queueSize.value = queue.length
		safeMark('drop', {reason: 'backpressure-evict-oldest'})
		return true
	}

	const exceedsLimits = (): boolean =>
		queueSize.value + 1 > policy.maxQueuedItems || queuedBytes.value + lineBytes > policy.maxQueuedBytes

	if (!exceedsLimits()) {
		commit()
		return true
	}

	const onOverflow: string | undefined = (policy as BackpressurePolicy & {onOverflow?: string}).onOverflow
	switch (onOverflow) {
		case 'drop-newest':
			safeMark('drop', {reason: 'backpressure-drop-newest'})
			return false
		case 'error': {
			safeMark('drop', {reason: 'backpressure-error'})
			safeError(new Error('transferring/backpressure: queue overflow'))
			return false
		}
		case 'block':
			safeError(new Error('transferring/backpressure: legacy block overflow policy is not supported; dropping newest'))
			safeMark('drop', {reason: 'backpressure-drop-newest'})
			return false
		case 'drop-oldest':
		default:
			// Evicting existing deliverable records cannot make a record fit when
			// that record alone exceeds either queue limit. Preserve the queue and
			// reject only the intrinsically unqueueable newest record.
			if (policy.maxQueuedItems < 1 || lineBytes > policy.maxQueuedBytes) {
				safeMark('drop', {reason: 'backpressure-drop-newest'})
				return false
			}
			while (exceedsLimits()) {
				if (!evictOldest()) {
					return false
				}
			}
			commit()
			return true
	}
}
