import {describe, expect, it, vi} from 'vitest'

import {classifyBuiltinResilienceError} from '../../../src/resilience/core/classifiers'

describe('managed resilience classifiers', () => {
	it('retries only transaction-safe database failures', () => {
		for (const code of ['40001', '40P01']) {
			expect(classifyBuiltinResilienceError('db-write', {code}, 0).retryable).toBe(true)
			expect(classifyBuiltinResilienceError('db-transaction', {code}, 0).retryable).toBe(true)
		}
		for (const code of ['57014', '54000', '54001', '54011', '54023', 'HY000']) {
			expect(classifyBuiltinResilienceError('db-read', {code}, 0).retryable).toBe(false)
			expect(classifyBuiltinResilienceError('db-write', {code}, 0).retryable).toBe(false)
		}
	})

	it('does not retry ambiguous write completion or post-admission connection loss', () => {
		expect(classifyBuiltinResilienceError('db-write', {code: '08007'}, 0)).toEqual({retryable: false, ambiguousCompletion: true})
		for (const code of ['08006', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']) expect(classifyBuiltinResilienceError('db-write', {code}, 0).retryable).toBe(false)
		for (const code of ['08001', 'ECONNREFUSED', 'ENOTFOUND']) expect(classifyBuiltinResilienceError('db-write', {code}, 0).retryable).toBe(true)
	})

	it('treats cancellation as permanent and parses both Retry-After formats', () => {
		expect(classifyBuiltinResilienceError('http', {name: 'AbortError', status: 503}, 0).retryable).toBe(false)
		expect(classifyBuiltinResilienceError('http', {status: 429, headers: new Headers({'retry-after': '2'})}, 0)).toMatchObject({retryable: true, delayMs: 2_000})
		const now = Date.now()
		expect(classifyBuiltinResilienceError('http', {status: 429, headers: new Headers({'retry-after': new Date(now + 5_000).toUTCString()})}, now).delayMs).toBeGreaterThan(3_000)
	})

	it('does not retry HTTP failures with ambiguous completion by default', () => {
		for (const classifier of ['http', 'storage'] as const) for (const status of [408, 500, 502, 503, 504]) {
			expect(classifyBuiltinResilienceError(classifier, {status}, 0)).toEqual({retryable: true, ambiguousCompletion: true})
		}
		for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
			expect(classifyBuiltinResilienceError('http', {code}, 0)).toEqual({retryable: true, ambiguousCompletion: true})
		}
		for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
			expect(classifyBuiltinResilienceError('http', {code}, 0)).toEqual({retryable: true})
		}
	})

	it('does not execute hostile error accessors while classifying', () => {
		const getter = vi.fn(() => 503)
		const error = Object.defineProperty({}, 'status', {enumerable: true, get: getter})
		expect(classifyBuiltinResilienceError('http', error, 0)).toEqual({retryable: false})
		expect(getter).not.toHaveBeenCalled()
	})

	it('never invokes provider-controlled header methods', () => {
		const get = vi.fn(() => '2')
		expect(classifyBuiltinResilienceError('http', {status: 429, headers: {get}}, 0))
			.toEqual({retryable: true, delayMs: undefined})
		expect(get).not.toHaveBeenCalled()
		expect(classifyBuiltinResilienceError('http', {status: 429, headers: {'retry-after': '2'}}, 0))
			.toEqual({retryable: true, delayMs: 2_000})
	})
})
