/**
 * Additional tracing redaction rules. Built-in protection is always applied.
 * RegExp keys are limited to bounded, repetition-free key matchers.
 */
export type TraceRedactionRule =
	| {readonly key: string | RegExp; readonly action: 'mask' | 'drop'}
	| {readonly key: string | RegExp; readonly action: 'truncate'; readonly maxBytes: number}
