import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'

export type RedactingPath = readonly (string | number)[]

export interface RedactingBudgets {
	maxDepth?: number
	maxStringBytes?: number
	maxArrayLength?: number
	maxObjectEntries?: number
}

type RedactingTarget = {readonly key: string | RegExp; readonly path?: never} |
	{readonly path: RedactingPath; readonly key?: never}
type NonTruncatingRule = RedactingTarget & {
	readonly action: 'mask' | 'hash' | 'drop'
	readonly maxBytes?: never
}
type TruncatingRule = RedactingTarget & {
	readonly action: 'truncate'
	readonly maxBytes: number
}

export type RedactingRule = NonTruncatingRule | TruncatingRule

export interface RedactingPolicy {
	redactKeys?: ReadonlyArray<string | RegExp>
	redactValuePatterns?: ReadonlyArray<RegExp>
	rules?: ReadonlyArray<RedactingRule>
}

export interface RedactingOptions {
	policy?: RedactingPolicy
	budgets?: RedactingBudgets
	errors?: Errors
}

export type Redacting = (
	record: Readonly<LogRecord>,
	options?: RedactingOptions
) => Promise<LogRecord> | LogRecord

export const REDACTION_MARKER = '[REDACTED]' as const

export interface RedactingCustomOptions {
	additionalKeys?: ReadonlyArray<string | RegExp>
	additionalValuePatterns?: ReadonlyArray<RegExp>
	additionalRules?: ReadonlyArray<RedactingRule>
	budgets?: RedactingBudgets
	errors?: Errors
}
