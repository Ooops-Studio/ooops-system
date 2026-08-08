import {z, type ZodType} from 'zod'

import {captureSingleFlightCallback} from './callback-flight'
import type {EventContractSchema} from './events'
import {isRuntimeProxy} from './runtime-object'

const runZodOperation = captureSingleFlightCallback(((operation: () => unknown) => operation()) as (
	...args: never[]
) => unknown) as <T>(operation: () => T) => T | undefined

export interface ZodEventSchema<TPayload> extends EventContractSchema<TPayload> {
	readonly zod: ZodType<TPayload>
	readonly safeParse: (input: unknown) => {success: true; data: TPayload} | {success: false; error: unknown}
}

export function createZodEventSchema<TPayload>(schema: ZodType<TPayload>): ZodEventSchema<TPayload> {
	if (schema === null || typeof schema !== 'object' || isRuntimeProxy(schema)) {
		throw new TypeError('SDK_EVENT_ZOD_SCHEMA_INVALID')
	}
	return Object.freeze({
		zod: schema,
		parse(input: unknown): TPayload {
			return runZodOperation(() => z.parse(schema, input)) as TPayload
		},
		safeParse(input: unknown) {
			const result = runZodOperation(() => z.safeParse(schema, input))
			if (!result) return {success: false as const, error: new TypeError('SDK_EVENT_ZOD_REENTRY_LIMIT')}
			return result.success
				? {success: true as const, data: result.data}
				: {success: false as const, error: result.error}
		},
		toJSONSchema(): Readonly<Record<string, unknown>> {
			return runZodOperation(() => z.toJSONSchema(schema)) as Record<string, unknown>
		}
	})
}
