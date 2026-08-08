/** @file Lazy redaction policy factory. */
import type {LogAttributes, LogContext} from '@ooopsstudio/core/contracts/logging'

import type {Redacting, RedactingOptions} from '../types/redacting'
import {createStageOnError} from '../utils/on-error'

import {buildContext, buildRecord, maskAttributesFailClosed, redactFreeformValue, redactString, safeRead, safeReadString, safeReadTags, safeReadValue, valuesEqual} from './redacting-utilities'

export function createRedacting(options: Readonly<RedactingOptions>): Redacting {

	const rules = options.policy?.rules ?? []
	const policy = options.policy ?? {}
	const hasPolicy = rules.length > 0 ||
		(policy.redactKeys?.length ?? 0) > 0 ||
		(policy.redactValuePatterns?.length ?? 0) > 0
	const budgets = {...options.budgets}
	const errors = options.errors
	const reportLoadError = createStageOnError(errors, {
		stage: 'redacting',
		step: 'load-policy'
	})
	const reportPolicyError = createStageOnError(errors, {
		stage: 'redacting',
		step: 'apply-policy'
	})

	// Lazy-load the structural policy engine; the built-in free-form sanitizer
	// below remains active for every preset, including custom configurations.
	let applyPolicySafeFn: typeof import('../features/redacting/apply-rules').applyPolicySafe | null = null
	let loadingPromise: Promise<void> | null = null

	const getApplyPolicySafe = async() => {

		if (applyPolicySafeFn) return applyPolicySafeFn

		if (loadingPromise) {
			await loadingPromise.catch((error: unknown) => {
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				reportLoadError(error)
				/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
				loadingPromise = null
			})
			return applyPolicySafeFn
		}

		loadingPromise = (async() => {
			const module = await import('../features/redacting/apply-rules')
			applyPolicySafeFn = module.applyPolicySafe
		})()

		await loadingPromise.catch((error: unknown) => {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			reportLoadError(error)
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			loadingPromise = null
		})
		return applyPolicySafeFn

	}

	return async(record) => {
		const context = safeRead<LogContext>(record, 'context')
		const oldAttrs = safeRead<LogAttributes>(context, 'attributes')
		const applyPolicy = hasPolicy ? await getApplyPolicySafe() : undefined
		let newAttrs: LogAttributes | undefined | null
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		if (hasPolicy && !applyPolicy) {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			newAttrs = maskAttributesFailClosed(oldAttrs)
		} else if (applyPolicy) {
			try {
				newAttrs = applyPolicy(oldAttrs, policy, budgets, errors)
			} catch(error) {
				reportPolicyError(error)
				newAttrs = maskAttributesFailClosed(oldAttrs)
			}
		} else {
			newAttrs = oldAttrs
		}
		const message = safeReadString(record, 'message')
		const namespace = safeReadString(context, 'namespace')
		const oldTags = safeReadTags(context)
		/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
		const nextMessage = redactString(message.value ?? '')
		const nextNamespace = namespace.value === undefined ? undefined : redactString(namespace.value)
		const nextTags = oldTags.tags?.map((tag) => redactString(tag))
		const oldError = safeReadValue(record, 'error')
		const nextError = oldError.exists ? redactFreeformValue(oldError.value) : undefined
		const attrsChanged = newAttrs != null && newAttrs !== oldAttrs
		const namespaceChanged = !namespace.safe || nextNamespace !== namespace.value
		const tagsChanged = nextTags !== undefined && (!oldTags.safe || !valuesEqual(nextTags, oldTags.tags))
		const errorChanged = !oldError.safe || nextError !== oldError.value
		if (
			!attrsChanged &&
				nextMessage === message.value &&
				!namespaceChanged &&
				!tagsChanged &&
				!errorChanged
		) return record

		const nextContext = buildContext(context, {
			attrsChanged,
			newAttrs,
			namespaceChanged,
			nextNamespace,
			tagsChanged,
			nextTags
		})
		return buildRecord(record, nextMessage, nextContext, errorChanged, nextError)
	}
}
