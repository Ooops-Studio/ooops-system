/**
 * @file Error handling utilities for tracing service.
 */
import type {LogAttributes} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {createServiceErrorReporter} from '@ooopsstudio/core/runtime/runtime/service-error-reporter'

import {captureCapability} from './capabilities'
/**
 * Create an error handler for tracing service.
 * Uses shared service error reporter from engines.
 */
export function createTracingOnError(
	errors: Errors | undefined,
	context: {stage: string; preset?: string}
): (error: unknown, extra?: LogAttributes) => void {
	const fixedContext: Record<string, unknown> = {
		stage: context.stage
	}
	if (context.preset) {
		fixedContext.preset = context.preset
	}
	const report = captureCapability<Parameters<Errors['report']>, ReturnType<Errors['report']>>(errors, 'report')
	return createServiceErrorReporter({
		...(report ? {errors: Object.freeze({report}) as Errors} : {}),
		fixedContext,
		serviceName: 'tracing'
	})
}
export function reportTracingShutdownError(
	errors: Errors | undefined,
	error: unknown,
	extra?: LogAttributes
): void {
	const reportError = createTracingOnError(errors, {stage: 'tracing'})
	reportError(error, {
		operation: 'shutdown',
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(extra ?? {})
	})
}
export function reportTracingFlushError(
	errors: Errors | undefined,
	error: unknown,
	extra?: LogAttributes
): void {
	const reportError = createTracingOnError(errors, {stage: 'tracing'})
	reportError(error, {
		operation: 'flush',
		/* v8 ignore next -- defensive branch not constructible through the public tracing API */
		...(extra ?? {})
	})
}
