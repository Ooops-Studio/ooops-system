import {describe, expect, it} from 'vitest'

import {
	commitMemoryStorageBudget,
	createMemoryStorageBudget,
	MAX_MEMORY_JOBS_BYTES
} from '../../../src/jobs/features/backends/memory-storage-budget'

describe('memory jobs storage budget', () => {
	it('commits multi-record reservations atomically and credits removals', () => {
		const budget = createMemoryStorageBudget()
		commitMemoryStorageBudget(budget, [
			{bucket: 'runs', key: 'old', value: {payload: 'old'}},
			{bucket: 'deadLetters', key: 'dead', value: {runId: 'old'}}
		])
		const before = budget.totalBytes
		commitMemoryStorageBudget(budget, [
			{bucket: 'runs', key: 'old', remove: true},
			{bucket: 'deadLetters', key: 'dead', remove: true},
			{bucket: 'runs', key: 'new', value: {payload: 'new'}}
		])
		expect(budget.sizes.runs.has('old')).toBe(false)
		expect(budget.sizes.deadLetters.has('dead')).toBe(false)
		expect(budget.sizes.runs.has('new')).toBe(true)
		expect(budget.totalBytes).toBeLessThan(before)
	})

	it('rejects overflow without partially changing size indexes', () => {
		const budget = createMemoryStorageBudget()
		budget.totalBytes = MAX_MEMORY_JOBS_BYTES - 1
		expect(() => commitMemoryStorageBudget(budget, [
			{bucket: 'runs', key: 'run', value: {payload: 'too-large-for-remaining-budget'}},
			{bucket: 'schedules', key: 'schedule', value: {id: 'schedule'}}
		])).toThrow('storage capacity')
		expect(budget.totalBytes).toBe(MAX_MEMORY_JOBS_BYTES - 1)
		expect(budget.sizes.runs).toEqual(new Map())
		expect(budget.sizes.schedules).toEqual(new Map())
	})
})
