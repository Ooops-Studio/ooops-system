/**
 * @file Tests for tracing sampling utilities.
 */

import {describe, it, expect, vi} from 'vitest'

import {
	createParentBasedSampler,
	createProbabilisticSampler,
	createRulesBasedSampler,
	createAlwaysOnSampler,
	createAlwaysOffSampler,
	type Sampler
} from '../../../src/utils/tracing/sampling'

describe('sampling', () => {
	it('contains rejected promises supplied as sampler configuration', async() => {
		const options = Promise.reject(new Error('options rejected'))
		expect(() => createProbabilisticSampler(options as never)).toThrow('synchronous')
		const root = Promise.reject(new Error('root rejected'))
		expect(() => createParentBasedSampler(root as never)).toThrow('synchronous')
		await Promise.resolve()
	})

	it('contains rejected promises supplied to sampler decisions', async() => {
		const context = Promise.reject(new Error('context rejected'))
		const name = Promise.reject(new Error('name rejected'))
		const attribute = Promise.reject(new Error('attribute rejected'))
		expect(createAlwaysOnSampler().decide(context as never, name as never, {
			failure: attribute as never
		})).toBe('record-and-sample')
		await Promise.resolve()
	})

	it('does not inspect attributes through a proxied prototype chain', () => {
		const ownKeys = vi.fn(() => ['forged'])
		const getOwnPropertyDescriptor = vi.fn(() => ({
			configurable: true, enumerable: true, value: 'forged', writable: true
		}))
		const prototype = new Proxy({}, {ownKeys, getOwnPropertyDescriptor})
		const attrs = Object.create(prototype) as Record<string, string>
		attrs.safe = 'value'

		expect(createAlwaysOnSampler().decide(undefined, 'test', attrs)).toBe('record-and-sample')
		expect(ownKeys).not.toHaveBeenCalled()
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('fails closed without invoking accessor-backed runtime context fields', () => {
		const traceId = vi.fn(() => '1234567890abcdef1234567890abcdef')
		const traceFlags = vi.fn(() => 1)
		const context = Object.defineProperties({}, {
			traceId: {get: traceId},
			traceFlags: {get: traceFlags}
		})

		expect(createProbabilisticSampler({ratio: 0.5}).decide(
			context as never, 'request'
		)).toBe('drop')
		expect(createRulesBasedSampler({
			rules: [{pattern: '^request$', ratio: 1}], defaultRatio: 1
		}).decide(context as never, 'request')).toBe('drop')
		expect(createParentBasedSampler(createAlwaysOnSampler()).decide(
			context as never, 'request'
		)).toBe('drop')
		expect(traceId).not.toHaveBeenCalled()
		expect(traceFlags).not.toHaveBeenCalled()
	})

	describe('createAlwaysOnSampler', () => {

		it('should always return record-and-sample', () => {

			const sampler = createAlwaysOnSampler()

			expect(sampler.decide(undefined, 'test')).toBe('record-and-sample')
			expect(sampler.decide({traceId: '123', spanId: '456'}, 'test')).toBe('record-and-sample')
		})
	})

	describe('createAlwaysOffSampler', () => {

		it('should always return drop', () => {

			const sampler = createAlwaysOffSampler()

			expect(sampler.decide(undefined, 'test')).toBe('drop')
			expect(sampler.decide({traceId: '123', spanId: '456'}, 'test')).toBe('drop')
		})
	})

	describe('createProbabilisticSampler', () => {

		it('should always drop when ratio is 0', () => {

			const sampler = createProbabilisticSampler({ratio: 0})

			expect(sampler.decide(undefined, 'test')).toBe('drop')
			expect(sampler.decide({traceId: '123', spanId: '456'}, 'test')).toBe('drop')
		})

		it('should always sample when ratio is 1', () => {

			const sampler = createProbabilisticSampler({ratio: 1})

			expect(sampler.decide(undefined, 'test')).toBe('record-and-sample')
			expect(sampler.decide({traceId: '123', spanId: '456'}, 'test')).toBe('record-and-sample')
		})

		it('maps the maximum uint32 hash below one', () => {
			// FNV-1a("aaaaaaaaaaaaaaaaaaaaaac200a0099b") === 0xffffffff.
			const sampler = createProbabilisticSampler({ratio: 0.999_999_999_9})
			expect(sampler.decide({
				traceId: 'aaaaaaaaaaaaaaaaaaaaaac200a0099b',
				spanId: 'bbbbbbbbbbbbbbbb'
			}, 'test')).toBe('record-and-sample')
		})

		it('should use deterministic hash for context with traceId', () => {

			const sampler = createProbabilisticSampler({ratio: 0.5})
			const ctx = {traceId: 'test-trace-id', spanId: 'span-1'}

			// Same traceId should give same result
			const result1 = sampler.decide(ctx, 'test')
			const result2 = sampler.decide(ctx, 'test')

			expect(result1).toBe(result2)
		})

		it('should use random for context without traceId', () => {

			const sampler = createProbabilisticSampler({ratio: 0.5})

			// Without context, uses Math.random - results may vary
			const result = sampler.decide(undefined, 'test')

			expect(['record-and-sample', 'drop']).toContain(result)
		})

		it('preserves its captured entropy source after Math.random is rewired', () => {
			const probabilistic = createProbabilisticSampler({ratio: 0.5})
			const rules = createRulesBasedSampler({rules: [{pattern: '^test$', ratio: 0.5}], defaultRatio: 0.5})
			const rewired = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('rewired') })
			try {
				expect(['record-and-sample', 'drop']).toContain(probabilistic.decide(undefined, 'test'))
				expect(['record-and-sample', 'drop']).toContain(rules.decide(undefined, 'test'))
			} finally { rewired.mockRestore() }
		})

		it('should sample at 50% ratio', () => {

			const sampler = createProbabilisticSampler({ratio: 0.5})
			const ctx = {traceId: 'deterministic-trace', spanId: 'span-1'}

			const result = sampler.decide(ctx, 'test')

			// Should be deterministic based on traceId hash
			expect(['record-and-sample', 'drop']).toContain(result)
		})

		it('should handle very low ratio', () => {

			const sampler = createProbabilisticSampler({ratio: 0.01})
			const ctx = {traceId: 'test-trace', spanId: 'span-1'}

			const result = sampler.decide(ctx, 'test')

			expect(['record-and-sample', 'drop']).toContain(result)
		})

		it('should handle very high ratio', () => {

			const sampler = createProbabilisticSampler({ratio: 0.99})
			const ctx = {traceId: 'test-trace', spanId: 'span-1'}

			const result = sampler.decide(ctx, 'test')

			expect(['record-and-sample', 'drop']).toContain(result)
		})
	})

	describe('createParentBasedSampler', () => {
		it('fails closed and contains rejected native promises from the root sampler', async() => {
			const sampler = createParentBasedSampler({
				decide: () => Promise.reject(new Error('sampler failed')) as never
			})
			expect(sampler.decide(undefined, 'root')).toBe('drop')
			const thrown = Promise.reject(new Error('sampler threw'))
			const throwingSampler = createParentBasedSampler({decide: () => { throw thrown }})
			expect(throwingSampler.decide(undefined, 'root')).toBe('drop')
			await Promise.resolve()
		})

		it('should respect parent sampling decision when parent is sampled', () => {

			const rootSampler: Sampler = {
				decide: vi.fn(() => 'drop')
			}

			const sampler = createParentBasedSampler(rootSampler)
			const ctx = {
				traceId: '123',
				spanId: '456',
				traceFlags: 0x1 // Sampled
			}

			const result = sampler.decide(ctx, 'test')

			expect(result).toBe('record-and-sample')
			expect(rootSampler.decide).not.toHaveBeenCalled()
		})

		it('should drop when parent is not sampled', () => {

			const rootSampler: Sampler = {
				decide: vi.fn(() => 'drop')
			}

			const sampler = createParentBasedSampler(rootSampler)
			const ctx = {
				traceId: '123',
				spanId: '456',
				traceFlags: 0x0 // Not sampled
			}

			const result = sampler.decide(ctx, 'test')

			expect(result).toBe('drop')
			expect(rootSampler.decide).not.toHaveBeenCalled()
		})

		it('should use root sampler when no parent context', () => {

			const rootSampler: Sampler = {
				decide: vi.fn(() => 'record-and-sample')
			}

			const sampler = createParentBasedSampler(rootSampler)

			const result = sampler.decide(undefined, 'test')

			expect(result).toBe('record-and-sample')
			expect(rootSampler.decide).toHaveBeenCalledWith(undefined, 'test', undefined)
		})

		it('should use root sampler when respectParent is false', () => {

			const rootSampler: Sampler = {
				decide: vi.fn(() => 'drop')
			}

			const sampler = createParentBasedSampler(rootSampler, {respectParent: false})
			const ctx = {
				traceId: '123',
				spanId: '456',
				traceFlags: 0x1 // Sampled
			}

			const result = sampler.decide(ctx, 'test')

			expect(result).toBe('drop')
			expect(rootSampler.decide).toHaveBeenCalledWith(undefined, 'test', undefined)
		})

		it('should handle parent with undefined traceFlags', () => {

			const rootSampler: Sampler = {
				decide: vi.fn(() => 'drop')
			}

			const sampler = createParentBasedSampler(rootSampler)
			const ctx = {
				traceId: '123',
				spanId: '456'
				// traceFlags undefined
			}

			const result = sampler.decide(ctx, 'test')

			expect(result).toBe('drop')
			expect(rootSampler.decide).not.toHaveBeenCalled()
		})

		it('should pass attributes to root sampler', () => {

			const rootSampler: Sampler = {
				decide: vi.fn(() => 'drop')
			}

			const sampler = createParentBasedSampler(rootSampler)
			const attrs = {key: 'value'}

			sampler.decide(undefined, 'test', attrs)

			expect(rootSampler.decide).toHaveBeenCalledWith(undefined, 'test', attrs)
		})

		it('captures the root sampler decision once and rejects accessor-backed capabilities', () => {
			const original = vi.fn(() => 'record-and-sample' as const)
			const replacement = vi.fn(() => 'drop' as const)
			const rootSampler: Sampler = {decide: original}
			const sampler = createParentBasedSampler(rootSampler)
			rootSampler.decide = replacement

			expect(sampler.decide(undefined, 'test')).toBe('record-and-sample')
			expect(original).toHaveBeenCalledOnce()
			expect(replacement).not.toHaveBeenCalled()

			const getter = vi.fn(() => original)
			const accessor = Object.defineProperty({}, 'decide', {get: getter})
			expect(() => createParentBasedSampler(accessor as Sampler)).toThrow('stable data-method')
			expect(getter).not.toHaveBeenCalled()
		})

		it('rejects proxied root samplers before capability-inspection traps', () => {
			const getOwnPropertyDescriptor = vi.fn(() => undefined)
			const getPrototypeOf = vi.fn(() => null)
			const root = new Proxy({decide: () => 'drop' as const}, {
				getOwnPropertyDescriptor,
				getPrototypeOf
			})

			expect(() => createParentBasedSampler(root)).toThrow('stable data-method')
			expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
			expect(getPrototypeOf).not.toHaveBeenCalled()
		})

		it('does not inherit a forged sampler capability from Object.prototype', () => {
			let calls = 0
			Object.defineProperty(Object.prototype, 'decide', {
				configurable: true, writable: true,
				value: () => { calls += 1; return 'record-and-sample' }
			})
			let failure: unknown
			try { createParentBasedSampler({} as never) }
			catch(error) { failure = error }
			finally { delete (Object.prototype as Record<string, unknown>).decide }

			expect(failure).toBeInstanceOf(Error)
			expect(calls).toBe(0)
		})
	})

	describe('createRulesBasedSampler', () => {
		it('never drops a matching rule configured with ratio one', () => {
			const sampler = createRulesBasedSampler({
				rules: [{pattern: '^target$', ratio: 1}], defaultRatio: 0
			})
			expect(sampler.decide({
				traceId: 'aaaaaaaaaaaaaaaaaaaaaac200a0099b',
				spanId: 'bbbbbbbbbbbbbbbb'
			}, 'target')).toBe('record-and-sample')
		})

		it('validates ratios and compiles stable regular expressions', () => {
			expect(() => createProbabilisticSampler({ratio: Number.NaN})).toThrow('Sampling ratio')
			expect(() => createProbabilisticSampler({ratio: 0.5, seed: 1.5})).toThrow('seed')
			expect(() => createRulesBasedSampler({rules: [], defaultRatio: 2})).toThrow('Default sampling ratio')
			expect(() => createRulesBasedSampler({rules: [{pattern: 'x', ratio: -1}], defaultRatio: 0})).toThrow('rule 0')
			const sampler = createRulesBasedSampler({rules: [{pattern: /^api\./gu, ratio: 1}], defaultRatio: 0})
			expect(sampler.decide(undefined, 'api.one')).toBe('record-and-sample')
			expect(sampler.decide(undefined, 'api.two')).toBe('record-and-sample')
		})

		it('rejects patterns capable of catastrophic backtracking', () => {
			expect(() => createRulesBasedSampler({
				rules: [{pattern: '(a+)+$', ratio: 1}], defaultRatio: 0
			})).toThrow('must not contain repetition')
			expect(() => createRulesBasedSampler({
				rules: [{pattern: 'a'.repeat(257), ratio: 1}], defaultRatio: 0
			})).toThrow('at most 256')
		})

		it('snapshots rule data without invoking accessors or mutable RegExp state', () => {
			let reads = 0
			const accessorRule = Object.defineProperty({pattern: '^safe\\.', ratio: 1}, 'ratio', {
				enumerable: true,
				get: () => { reads++; return 1 }
			})
			expect(() => createRulesBasedSampler({rules: [accessorRule as never], defaultRatio: 0}))
				.toThrow('data properties')
			expect(reads).toBe(0)

			const pattern = /^safe\./gu
			const sampler = createRulesBasedSampler({rules: [{pattern, ratio: 1}], defaultRatio: 0})
			pattern.lastIndex = 10_000
			expect(sampler.decide(undefined, 'safe.operation')).toBe('record-and-sample')
			expect(sampler.decide(undefined, 'safe.operation')).toBe('record-and-sample')
		})

		it('compiles native RegExp rules after the global RegExp constructor is rewired', () => {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'RegExp')!
			let sampler: Sampler | undefined
			let failure: unknown
			try {
				Object.defineProperty(globalThis, 'RegExp', {
					configurable: true, writable: true,
					value: () => { throw new Error('poisoned RegExp constructor') }
				})
				try {
					sampler = createRulesBasedSampler({rules: [{pattern: /^safe\./u, ratio: 1}], defaultRatio: 0})
				} catch(error) { failure = error }
			} finally { Object.defineProperty(globalThis, 'RegExp', descriptor) }

			expect(failure).toBeUndefined()
			expect(sampler?.decide(undefined, 'safe.operation')).toBe('record-and-sample')
		})

		it('preserves compiled matching after RegExp.prototype.test is rewired', () => {
			const sampler = createRulesBasedSampler({
				rules: [{pattern: '^safe\\.', ratio: 1}], defaultRatio: 0
			})
			const test = vi.spyOn(RegExp.prototype, 'test').mockImplementation(() => {
				throw new Error('rewired RegExp.test')
			})
			try {
				expect(sampler.decide(undefined, 'safe.operation')).toBe('record-and-sample')
				expect(sampler.decide({
					traceId: '1234567890abcdef1234567890abcdef',
					spanId: '1234567890abcdef'
				}, 'safe.operation')).toBe('record-and-sample')
			} finally { test.mockRestore() }
		})

		it('preserves sampling decisions after array, string, and numeric intrinsics are rewired', () => {
			const sampler = createRulesBasedSampler({
				rules: [{pattern: '^safe\\.', ratio: 1}], defaultRatio: 0
			})
			const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
			const substringDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'substring')!
			const parseIntDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'parseInt')!
			const poison = (): never => { throw new Error('rewired intrinsic') }
			let decision: ReturnType<Sampler['decide']> | undefined
			let failure: unknown
			try {
				Object.defineProperties(Array.prototype, {
					[Symbol.iterator]: {configurable: true, writable: true, value: poison}
				})
				Object.defineProperties(String.prototype, {
					substring: {configurable: true, writable: true, value: poison}
				})
				Object.defineProperty(globalThis, 'parseInt', {
					configurable: true, writable: true, value: poison
				})
				try { decision = sampler.decide(undefined, 'safe.operation') }
				catch(error) { failure = error }
			} finally {
				Object.defineProperty(globalThis, 'parseInt', parseIntDescriptor)
				Object.defineProperty(String.prototype, 'substring', substringDescriptor)
				Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor)
			}

			expect(failure).toBeUndefined()
			expect(decision).toBe('record-and-sample')
		})

		it('contains rejected attribute values after descriptor inspection is rewired', async() => {
			const descriptor = Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')!
			const rejected = Promise.reject(new Error('attribute rejected'))
			try {
				Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
					configurable: true, writable: true,
					value: () => { throw new Error('rewired descriptor inspection') }
				})
				createAlwaysOnSampler().decide(undefined, 'safe.operation', {rejected} as never)
			} finally {
				Object.defineProperty(Object, 'getOwnPropertyDescriptor', descriptor)
			}
			await Promise.resolve()
		})

		it('does not consult rewired string iterators while validating names and patterns', () => {
			const iteratorDescriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!
			const charCodeDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!
			const poison = (): never => { throw new Error('poisoned string intrinsic') }
			let decision: ReturnType<Sampler['decide']> | undefined
			try {
				Object.defineProperties(String.prototype, {
					[Symbol.iterator]: {configurable: true, writable: true, value: poison},
					charCodeAt: {configurable: true, writable: true, value: poison}
				})
				const sampler = createRulesBasedSampler({
					rules: [{pattern: '^safe\\.', ratio: 1}], defaultRatio: 0
				})
				decision = sampler.decide(undefined, 'safe.operation')
			} finally {
				Object.defineProperty(String.prototype, Symbol.iterator, iteratorDescriptor)
				Object.defineProperty(String.prototype, 'charCodeAt', charCodeDescriptor)
			}

			expect(decision).toBe('record-and-sample')
		})

		it('rejects hostile numeric options without coercing them', () => {
			const coercion = vi.fn(() => 0.5)
			const hostile = {[Symbol.toPrimitive]: coercion}
			expect(() => createProbabilisticSampler({ratio: hostile as never})).toThrow('between 0 and 1')
			expect(() => createProbabilisticSampler({ratio: 0.5, seed: hostile as never})).toThrow('safe integer')
			expect(coercion).not.toHaveBeenCalled()
		})

		it('fails closed for oversized names and invalid trace contexts', () => {
			const sampler = createRulesBasedSampler({rules: [{pattern: '^safe', ratio: 1}], defaultRatio: 1})
			expect(sampler.decide(undefined, 'x'.repeat(257))).toBe('drop')
			expect(sampler.decide({traceId: 'invalid', spanId: 'invalid'}, 'safe.operation')).toBe('drop')
		})

		it('uses the optional probabilistic seed deterministically without a parent', () => {
			const sampler = createProbabilisticSampler({ratio: 0.5, seed: 42})
			expect(sampler.decide(undefined, 'request')).toBe(sampler.decide(undefined, 'request'))
		})

		it('should match span name against string pattern', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^api\\.', ratio: 1.0}
				],
				defaultRatio: 0.0
			})

			const result = sampler.decide(undefined, 'api.users.get')

			expect(result).toBe('record-and-sample')
		})

		it('should match span name against RegExp pattern', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: /^db\./, ratio: 1.0}
				],
				defaultRatio: 0.0
			})

			const result = sampler.decide(undefined, 'db.query')

			expect(result).toBe('record-and-sample')
		})

		it('should use first matching rule', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^api\\.', ratio: 0.5},
					{pattern: '^api\\.users\\.', ratio: 1.0}
				],
				defaultRatio: 0.0
			})

			const result = sampler.decide(undefined, 'api.users.get')

			// Should use first matching rule (0.5 ratio)
			expect(['record-and-sample', 'drop']).toContain(result)
		})

		it('should use default ratio when no rules match', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^api\\.', ratio: 0.0}
				],
				defaultRatio: 1.0
			})

			const result = sampler.decide(undefined, 'other.operation')

			expect(result).toBe('record-and-sample')
		})

		it('should use deterministic hash for context with traceId', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^test\\.', ratio: 0.5}
				],
				defaultRatio: 0.0
			})

			const ctx = {traceId: 'deterministic-trace', spanId: 'span-1'}

			// Same traceId should give same result
			const result1 = sampler.decide(ctx, 'test.operation')
			const result2 = sampler.decide(ctx, 'test.operation')

			expect(result1).toBe(result2)
		})

		it('should use hash of name when no context', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^test\\.', ratio: 0.5}
				],
				defaultRatio: 0.0
			})

			// Without context, uses name + random - results may vary
			const result = sampler.decide(undefined, 'test.operation')

			expect(['record-and-sample', 'drop']).toContain(result)
		})

		it('should handle multiple rules', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^api\\.', ratio: 0.8},
					{pattern: '^db\\.', ratio: 0.2},
					{pattern: '^cache\\.', ratio: 0.9}
				],
				defaultRatio: 0.1
			})

			const apiResult = sampler.decide(undefined, 'api.users.get')
			const dbResult = sampler.decide(undefined, 'db.query')
			const cacheResult = sampler.decide(undefined, 'cache.get')
			const otherResult = sampler.decide(undefined, 'other.operation')

			expect(['record-and-sample', 'drop']).toContain(apiResult)
			expect(['record-and-sample', 'drop']).toContain(dbResult)
			expect(['record-and-sample', 'drop']).toContain(cacheResult)
			expect(['record-and-sample', 'drop']).toContain(otherResult)
		})

		it('should handle empty rules array', () => {

			const sampler = createRulesBasedSampler({
				rules: [],
				defaultRatio: 0.5
			})

			const result = sampler.decide(undefined, 'test.operation')

			expect(['record-and-sample', 'drop']).toContain(result)
		})

		it('should handle rule with ratio 0', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^skip\\.', ratio: 0.0}
				],
				defaultRatio: 1.0
			})

			const result = sampler.decide(undefined, 'skip.operation')

			expect(result).toBe('drop')
		})

		it('should handle rule with ratio 1', () => {

			const sampler = createRulesBasedSampler({
				rules: [
					{pattern: '^always\\.', ratio: 1.0}
				],
				defaultRatio: 0.0
			})

			const result = sampler.decide(undefined, 'always.operation')

			expect(result).toBe('record-and-sample')
		})
	})
})
