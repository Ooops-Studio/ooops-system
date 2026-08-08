import type {LogContext} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'

import {createBaseContextEnriching} from '../features/enriching/base-context'
import type {Enriching} from '../types/enriching'
import {createStageOnError} from '../utils/on-error'

export const createEnriching = (context: LogContext, errors?: Errors): Enriching => {
	const onError = createStageOnError(errors, {stage: 'enriching', step: 'base-context'})
	let base: Enriching
	try { base = createBaseContextEnriching(context, errors) } catch(error) {
		onError(error)
		return (record) => record
	}
	return async(record, options) => {
		try { return await base(record, options) } catch(error) {
			onError(error)
			return record
		}
	}
}
