import type {RateLimitDecision} from '@ooopsstudio/core/contracts/rate-limit'

import type {RateLimit429ResponseMeta, RateLimitHeaders} from '../types/http'

import {isRateLimitProxy} from './safe-object'

function snapshotDecision(value: unknown): RateLimitDecision {
	if (!value || typeof value !== 'object' || isRateLimitProxy(value) || Array.isArray(value)) throw new TypeError('Rate limit decision must be a plain object')
	try {
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const expected = new Set(['allowed', 'policy', 'limit', 'remaining', 'resetAt', 'retryAfterMs', 'reason'])
		if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !expected.has(key))) throw new TypeError()
		if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new TypeError()
		return Object.freeze({
			allowed: descriptors.allowed?.value as boolean,
			policy: descriptors.policy?.value as string,
			limit: descriptors.limit?.value as number,
			remaining: descriptors.remaining?.value as number,
			resetAt: descriptors.resetAt?.value as number | null,
			retryAfterMs: descriptors.retryAfterMs?.value as number | null,
			reason: descriptors.reason?.value as RateLimitDecision['reason']
		})
	} catch { throw new TypeError('Rate limit decision contains invalid or accessor-backed fields') }
}

function seconds(milliseconds: number | null): number | null {
	return milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0
		? null
		: Math.ceil(milliseconds / 1_000)
}

export function decisionToHeaders(value: RateLimitDecision, nowMs = Date.now()): RateLimitHeaders {
	const decision = snapshotDecision(value)
	if (!Number.isSafeInteger(decision.limit) || decision.limit <= 0 ||
		!Number.isSafeInteger(decision.remaining) || decision.remaining < 0 || decision.remaining > decision.limit) {
		throw new TypeError('Rate limit decision contains invalid capacity values')
	}
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
		(decision.resetAt !== null && (!Number.isSafeInteger(decision.resetAt) || decision.resetAt < 0)) ||
		(decision.retryAfterMs !== null && (!Number.isSafeInteger(decision.retryAfterMs) || decision.retryAfterMs < 0))) {
		throw new TypeError('Rate limit decision contains invalid time values')
	}
	const headers: Record<string, string> = {
		'RateLimit-Limit': String(decision.limit),
		'RateLimit-Remaining': String(decision.remaining)
	}
	if (decision.resetAt !== null) headers['RateLimit-Reset'] = String(Math.ceil(Math.max(0, decision.resetAt - nowMs) / 1_000))
	const retry = seconds(decision.retryAfterMs)
	if (!decision.allowed && retry !== null) headers['Retry-After'] = String(retry)
	return Object.freeze(headers)
}

export function decisionTo429ResponseMeta(value: RateLimitDecision, nowMs = Date.now()): RateLimit429ResponseMeta | null {
	const decision = snapshotDecision(value)
	if (decision.allowed) return null
	return Object.freeze({
		status: 429,
		reason: 'rate_limit_exceeded',
		policy: decision.policy,
		headers: decisionToHeaders(decision, nowMs),
		retryAfterMs: decision.retryAfterMs,
		retryAfterSeconds: seconds(decision.retryAfterMs),
		resetAt: decision.resetAt
	})
}
