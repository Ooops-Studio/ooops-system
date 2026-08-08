import {createContainer, type Container} from '@ooopsstudio/core/runtime'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it} from 'vitest'

import {registerJobs} from '../../src/jobs'
import {createMemoryJobsBackend} from '../../src/jobs/features/backends/memory'
import {createCustomJobs} from '../../src/jobs/public/custom'

describe('Jobs public contracts and registration', () => {
	it('binds ManagedJobs and the optional built-in admin capability atomically', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(0))
		await registerJobs(container, {preset: 'development'})
		expect(container.has(TOK.Jobs)).toBe(true)
		expect(container.has(TOK.JobsAdmin)).toBe(true)
		await container.get<{shutdown(): Promise<void>}>(TOK.Jobs).shutdown()
	})

	it('does not synthesize admin for a custom backend without that capability', async() => {
		const memory = createMemoryJobsBackend()
		const backend = {
			durability: memory.durability,
			runs: memory.runs,
			schedules: memory.schedules,
			maintenance: memory.maintenance
		}
		const runtime = await createCustomJobs({clock: createFixedClock(0), backend})
		expect(runtime.admin).toBeUndefined()
		await runtime.jobs.shutdown()
	})

	it('rejects hostile registration objects without executing accessors', async() => {
		let called = false
		const config = Object.defineProperty({}, 'preset', {
			enumerable: true,
			get() { called = true; return 'development' }
		})
		await expect(registerJobs(createContainer(), config as never)).rejects.toThrow()
		expect(called).toBe(false)
	})

	it('rejects duplicate registration and production memory composition', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(0))
		await registerJobs(container, {preset: 'development'})
		await expect(registerJobs(container, {preset: 'development'})).rejects.toThrow('already registered')
		const production = createContainer()
		production.bind(TOK.Clock, createFixedClock(0))
		await expect(registerJobs(production, {
			preset: 'production', options: {backend: createMemoryJobsBackend()}
		})).rejects.toThrow('durable backend')
		await container.get<{shutdown(): Promise<void>}>(TOK.Jobs).shutdown()
	})

	it('rolls back partial token binding and permits a clean retry', async() => {
		const inner = createContainer()
		inner.bind(TOK.Clock, createFixedClock(0))
		let failAdmin = true
		const container: Container = {
			...inner,
			bind(token, value) {
				if (token === TOK.JobsAdmin && failAdmin) {
					failAdmin = false
					throw new Error('synthetic admin bind failure')
				}
				inner.bind(token, value)
			}
		}
		await expect(registerJobs(container, {preset: 'development'})).rejects.toThrow(
			'synthetic admin bind failure'
		)
		expect(container.has(TOK.Jobs)).toBe(false)
		expect(container.has(TOK.JobsAdmin)).toBe(false)
		await registerJobs(container, {preset: 'development'})
		await container.get<{shutdown(): Promise<void>}>(TOK.Jobs).shutdown()
	})

	it('does not remove a competing registration that wins during runtime creation', async() => {
		const inner = createContainer()
		inner.bind(TOK.Clock, createFixedClock(0))
		const competing = {owner: 'external'}
		let raced = false
		const container: Container = {
			...inner,
			get(token) {
				const value = inner.get(token)
				if (token === TOK.Clock && !raced) {
					raced = true
					inner.bind(TOK.Jobs, competing)
				}
				return value
			}
		}
		await expect(registerJobs(container, {preset: 'development'})).rejects.toThrow(
			'registered during runtime creation'
		)
		expect(inner.get(TOK.Jobs)).toBe(competing)
		inner.unbind(TOK.Jobs)
	})

	it('rolls back an owned binding installed before bind throws', async() => {
		const inner = createContainer()
		inner.bind(TOK.Clock, createFixedClock(0))
		const container: Container = {
			...inner,
			bind(token, value) {
				inner.bind(token, value)
				if (token === TOK.Jobs) throw new Error('hostile bind failure')
			}
		}
		await expect(registerJobs(container, {preset: 'development'})).rejects.toThrow('hostile bind failure')
		expect(inner.has(TOK.Jobs)).toBe(false)
	})

	it('preserves a foreign value installed instead of the requested binding', async() => {
		const inner = createContainer()
		inner.bind(TOK.Clock, createFixedClock(0))
		const foreign = {owner: 'foreign'}
		const container: Container = {
			...inner,
			bind(token, value) {
				inner.bind(token, token === TOK.Jobs ? foreign : value)
			}
		}
		await expect(registerJobs(container, {preset: 'development'})).rejects.toThrow(
			'did not retain the registered runtime'
		)
		expect(inner.get(TOK.Jobs)).toBe(foreign)
		inner.unbind(TOK.Jobs)
	})
})
