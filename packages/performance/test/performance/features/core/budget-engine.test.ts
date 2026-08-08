import {describe, expect, it, vi} from 'vitest'

import {createBudgetEngine} from '../../../../src/performance/features/core/budget-engine'

describe('streaming budget engine', () => {
	it('matches adversarial wildcards without dynamic regular expressions', () => {
		const engine = createBudgetEngine()
		const RuntimeRegExp = globalThis.RegExp
		vi.stubGlobal('RegExp', class { constructor() { throw new Error('dynamic regex forbidden') } })
		try {
			engine.registerBudget({name: 'bounded', pattern: `${'*a'.repeat(100)}*z`, target: 1, window: 1_000})
			expect(engine.checkEvent({
				name: 'a'.repeat(128), duration: 2, start: 0, end: 1, source: 'mark'
			})).toEqual([])
		} finally {
			vi.stubGlobal('RegExp', RuntimeRegExp)
		}
	})

	it('evaluates bounded samples without an event buffer', () => {
		const onViolation = vi.fn()
		const engine = createBudgetEngine({onViolation, maxSamplesPerBudget: 2, now: () => 100})
		engine.registerBudget({name: 'http.*', target: 10, window: 100})
		engine.checkEvent({name: 'http.request', duration: 20, start: 80, end: 100, source: 'mark'})
		expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({actual: 20}))
		expect(engine.getStatus('http.*')).toMatchObject({violated: true, current: 20})
		engine.reset()
	})

	it('validates budget and sample configuration', () => {
		expect(() => createBudgetEngine({maxSamplesPerBudget: 0})).toThrow()
		expect(() => createBudgetEngine({maxSamplesPerBudget: 100_001})).toThrow()
		const engine = createBudgetEngine()
		expect(() => engine.registerBudget({name: '', target: 1, window: 1})).toThrow()
		expect(() => engine.registerBudget({name: 'x'.repeat(129), target: 1, window: 1})).toThrow()
		expect(() => engine.registerBudget({name: 'x', target: -1, window: 1})).toThrow()
		expect(() => engine.registerBudget({name: 'x', target: 1, window: 0})).toThrow()
		expect(() => engine.registerBudget({name: 'x', target: 1, window: 1, percentile: 2})).toThrow()
		expect(() => engine.registerBudget({name: 'x', pattern: ' ', target: 1, window: 1})).toThrow('pattern')
		expect(engine.getStatus('missing')).toBeUndefined()
	})

	it('clears samples and violations when a named budget is replaced', () => {
		const engine = createBudgetEngine({now: () => 10})
		engine.registerBudget({name: 'request', target: 5, window: 100})
		engine.checkEvent({name: 'request', duration: 10, start: 0, end: 10, source: 'mark'})
		expect(engine.getStatus('request')).toMatchObject({violated: true, violationCount: 1})
		engine.registerBudget({name: 'request', target: 20, window: 100})
		expect(engine.getStatus('request')).toMatchObject({current: 0, violated: false, violationCount: 0})
	})

	it('uses exact matching, escaped globs, transition alerts, recovery, and a monotonic window', () => {
		let time = 10
		const onViolation = vi.fn()
		const engine = createBudgetEngine({now: () => time, onViolation})
		engine.registerBudget({name: 'query', target: 5, window: 5})
		engine.registerBudget({name: 'db.glob', pattern: 'db.*.read', target: 5, window: 5})
		expect(engine.getStatus('query')).toMatchObject({current: 0, violated: false})
		expect(() => engine.checkEvent({name: 'db.query', duration: 10, start: 9, end: 10, source: 'mark'})).not.toThrow()
		engine.checkEvent({name: 'db.users.read', duration: 10, start: 9, end: 10, source: 'mark'})
		engine.checkEvent({name: 'db.users.read', duration: 11, start: 10, end: 11, source: 'mark'})
		expect(onViolation).toHaveBeenCalledTimes(1)
		// A regressing clock never makes the bounded window run backwards.
		time = 1
		expect(engine.getStatus('db.glob')).toMatchObject({violated: true, violationCount: 1})
		time = 20
		expect(engine.getStatus('db.glob')).toMatchObject({violated: false, violationCount: 0})
		engine.checkEvent({name: 'db.users.read', duration: 12, start: 20, end: 20, source: 'mark'})
		expect(onViolation).toHaveBeenCalledTimes(2)
		expect(engine.getStatus('query')).toMatchObject({current: 0, violationCount: 0})
	})
})
