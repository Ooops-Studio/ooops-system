import {byteSize} from '@ooopsstudio/core/utils/byte-size'

import {QUEUE_BYTES_PRODUCTION, QUEUE_ITEMS_PRODUCTION} from '../../constants'
import {inspectLoggingProperty} from '../../utils/capabilities'

export function snapshotLoggingPayloadLines(value: unknown): string[] {
	if (!Array.isArray(value)) throw new TypeError('Logging payload must be an array of lines')
	const inspectedLength = inspectLoggingProperty<unknown>(value, 'length')
	if (!inspectedLength.safe || !Number.isSafeInteger(inspectedLength.value)
		|| (inspectedLength.value as number) < 0
		|| (inspectedLength.value as number) > QUEUE_ITEMS_PRODUCTION) {
		throw new RangeError('Logging payload line count exceeds the transport limit')
	}
	const length = inspectedLength.value as number
	const snapshot: string[] = []
	let bytes = 0
	for (let index = 0; index < length; index += 1) {
		const inspected = inspectLoggingProperty<unknown>(value, String(index))
		if (!inspected.safe || typeof inspected.value !== 'string') {
			throw new TypeError('Logging payload lines must be strings without accessors')
		}
		bytes += byteSize(inspected.value) + 1
		if (bytes > QUEUE_BYTES_PRODUCTION) {
			throw new RangeError('Logging payload bytes exceed the transport limit')
		}
		snapshot.push(inspected.value)
	}
	return snapshot
}
