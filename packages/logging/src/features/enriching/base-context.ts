import type {LogAttributes, LogContext} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import type {Enriching} from '../../types/enriching'
import {mergeContext, mergeTags, snapshotLogContext} from '../../utils/enriching'
import {createStageOnError} from '../../utils/on-error'

export interface BaseContext {
	readonly namespace?: string
	readonly attributes?: LogAttributes
	readonly tags?: readonly string[]
}

export const createBaseContextEnriching =
	(base: Readonly<BaseContext>, errors?: Errors): Enriching => {
		const baseSnapshot = snapshotLogContext(base as LogContext) ?? {}
		return (record, options) => {
			const onError = createStageOnError(errors, {
				stage: 'enriching',
				step: 'base-context'
			})
			try {
				// Merge base context (from closure) with options.context (per-call override)
				const overrideContext = options?.context
				const effectiveBase = overrideContext
					? mergeContext(baseSnapshot, overrideContext)
					: baseSnapshot
				const recordContext = (() => {
					try {
						return record.context
					/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
					} catch {
						/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
						return undefined
					/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
					}
				})()
				const nextContextBase = mergeContext(effectiveBase, recordContext ?? {})
				const nextTags = mergeTags(recordContext?.tags, effectiveBase.tags)
				const nextContext: Record<string, unknown> = {...nextContextBase}
				if (nextTags && nextTags.length) {
					nextContext.tags = nextTags
				} else {
					delete nextContext.tags
				}

				return {
					...record,
					context: nextContext
				}
			} catch(error) {
				// Log error but continue with original record
				onError(error)
				return record
			}
		}
	}
