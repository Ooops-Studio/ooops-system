import type {JsonValue} from '@ooopsstudio/core/contracts/json'
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import {isPlainObject} from '@ooopsstudio/core/utils/guards'

export function maskSpanAttributes(attrs: LogAttributes): LogAttributes {
	const masked: Record<string, JsonValue> = {}
	try {
		if (!isPlainObject(attrs)) return masked
		for (const key of Object.keys(attrs)) masked[key] = '***'
	} catch { return {} }
	return masked
}
