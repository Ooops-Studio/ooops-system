import type {Errors} from '@ooopsstudio/core/ports/errors'

import {createRedacting} from '../core/redacting'
import type {Redacting, RedactingRule} from '../types/redacting'
import {mergeRedactingPolicies, SAFE_DEFAULT_REDACTING_POLICY} from '../utils/redaction-policy'

const PRODUCTION_RULES: ReadonlyArray<RedactingRule> = [
	{key: 'password', action: 'drop'},
	{key: 'authorization', action: 'drop'},
	{key: 'cookie', action: 'drop'},
	{key: 'set_cookie', action: 'drop'},
	{key: 'email', action: 'drop'},
	{key: 'phone', action: 'drop'},
	{key: 'ssn', action: 'drop'},
	{key: 'credit_card', action: 'drop'},
	{key: 'cvv', action: 'drop'},
	{key: 'session_id', action: 'hash'},
	{key: 'user_id', action: 'hash'}
]

export async function createProductionRedacting(errors?: Errors): Promise<Redacting> {
	return createRedacting({
		policy: mergeRedactingPolicies(SAFE_DEFAULT_REDACTING_POLICY, {rules: PRODUCTION_RULES}),
		budgets: {maxDepth: 8, maxStringBytes: 8_192, maxArrayLength: 1_000, maxObjectEntries: 1_000},
		...(errors ? {errors} : {})
	})
}
