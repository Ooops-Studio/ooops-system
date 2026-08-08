/**
 * @file Error handling utilities for performance service.
 * Uses shared service error reporter from engines with registry fallback.
 */

import type {Errors} from '@ooopsstudio/core/ports/errors'
import {createServiceErrorReporter} from '@ooopsstudio/core/runtime/runtime/service-error-reporter'

import {isRuntimePromise, isRuntimeProxy} from './safe-object'

type ReportMethod = (...args: unknown[]) => unknown

const captureReport = (errors: Errors | undefined): ReportMethod | undefined => {
	if (!errors || isRuntimeProxy(errors)) return undefined
	try {
		let owner: object | null = errors
		for (let depth = 0; owner && depth < 16; depth += 1) {
			if (isRuntimeProxy(owner)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(owner, 'report')
			if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
				? descriptor.value as ReportMethod
				: undefined
			owner = Object.getPrototypeOf(owner) as object | null
		}
	} catch { return undefined }
	return undefined
}

/**
 * Create an error handler function for performance stage errors.
 * Uses shared service error reporter from engines with registry fallback.
 *
 * @param errors - Optional errors port
 * @param fixedContext - Fixed context to include with all errors
 * @returns Error handler function
 */
export function createPerformanceOnError(
	errors?: Errors,
	fixedContext?: Record<string, string>
): (error: unknown, extra?: Record<string, string>) => void {
	const report = captureReport(errors)
	let pending = false
	const guardedErrors = report && errors ? {
		report(...args: unknown[]): void {
			if (pending) return
			pending = true
			let result: unknown
			try { result = Reflect.apply(report, errors, args) } catch(error) {
				pending = false
				throw error
			}
			if (!isRuntimePromise(result)) { pending = false; return }
			const release = () => { pending = false }
			try { void Reflect.apply(Promise.prototype.then, result, [release, release]) }
			catch { release() }
		}
	} as Errors : undefined
	return createServiceErrorReporter({
		...(guardedErrors ? {errors: guardedErrors} : {}),
		...(fixedContext ? {fixedContext} : {}),
		serviceName: 'performance'
	})
}
