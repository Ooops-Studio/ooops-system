import type {CpuProfileArtifact} from '@ooopsstudio/core/ports/profiling'
import {createContainer, type Container} from '@ooopsstudio/core/runtime'
import {TOK} from '@ooopsstudio/core/tokens'
import {describe, expect, it, vi} from 'vitest'

import {registerProfiling} from '../src'
import type {ManagedProfiling} from '../src/types'

const artifact: CpuProfileArtifact = {
	type: 'cpu', format: 'cpuprofile', name: 'registration', startedAt: 1, endedAt: 2,
	durationMs: 1, captured: true, payload: '{}', resource: {}
}

describe('profiling registration boundary', () => {
	it('rejects configuration accessors without executing them and releases registration admission', async() => {
		const container = createContainer()
		let reads = 0
		const hostile = Object.defineProperty({preset: 'development'}, 'options', {
			enumerable: true,
			get() { reads++; throw new Error('authorization=secret-options') }
		})
		await expect(registerProfiling(container, hostile as never)).rejects.toThrow('profiling_invalid_registration')
		expect(reads).toBe(0)

		await registerProfiling(container, {preset: 'custom', options: {
			profiler: {capture: async() => artifact},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		}})
		await container.get<ManagedProfiling>(TOK.Profiling).shutdown()
	})

	it('rejects unknown option accessors without executing them', async() => {
		const container = createContainer()
		let reads = 0
		const options = Object.defineProperty({
			profiler: {capture: async() => artifact},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		}, 'authorization', {enumerable: true, get() { reads++; return 'secret' }})

		await expect(registerProfiling(container, {preset: 'custom', options})).rejects.toThrow('profiling_invalid_registration')
		expect(reads).toBe(0)
	})

	it('rejects excessive registration keys before materializing descriptors', async() => {
		const container = createContainer(); let descriptorReads = 0
		const options = new Proxy(Object.fromEntries(
			Array.from({length: 100}, (_, index) => [`field${index}`, index])
		), {
			getOwnPropertyDescriptor(target, key) {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		await expect(registerProfiling(container, {preset: 'custom', options} as never))
			.rejects.toThrow('profiling_invalid_registration')
		expect(descriptorReads).toBe(0)
	})

	it('rolls back a started runtime when the container silently drops its binding', async() => {
		const base = createContainer()
		const container: Container = {...base, bind: () => undefined}
		const shutdown = vi.fn(async() => undefined)
		await expect(registerProfiling(container, {preset: 'custom', options: {continuous: {
			start: async() => undefined,
			shutdown,
			getStatus: () => ({state: 'running', healthy: true})
		}}})).rejects.toThrow('profiling_container_binding_failed')
		expect(container.has(TOK.Profiling)).toBe(false)
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('retries a transient runtime cleanup failure during binding rollback', async() => {
		const base = createContainer(); let attempts = 0
		const container: Container = {...base, bind: () => undefined}
		await expect(registerProfiling(container, {preset: 'custom', options: {continuous: {
			start: async() => undefined,
			shutdown: async() => { if (++attempts === 1) throw new Error('transient cleanup failure') },
			getStatus: () => ({state: 'running', healthy: true})
		}}})).rejects.toThrow('profiling_container_binding_failed')
		expect(attempts).toBe(2)
	})

	it('accepts the authoritative binding when bind throws after installing it', async() => {
		const base = createContainer()
		const container: Container = {
			...base,
			bind: (token, value) => { base.bind(token, value); throw new Error('late bind failure') }
		}
		await registerProfiling(container, {preset: 'custom', options: {continuous: {
			start: async() => undefined,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		}}})
		const runtime = container.get<ManagedProfiling>(TOK.Profiling)
		expect(runtime.getStatus().state).toBe('running')
		await runtime.shutdown()
	})

	it('requires reversible container bindings before creating a runtime', async() => {
		const base = createContainer()
		const start = vi.fn(async() => undefined)
		const container: Container = {...base, unbind: undefined}
		await expect(registerProfiling(container, {preset: 'custom', options: {continuous: {
			start,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		}}})).rejects.toThrow('profiling_invalid_container')
		expect(start).not.toHaveBeenCalled()
	})

	it('rejects an existing binding even when a malformed container hides it from has', async() => {
		const base = createContainer()
		base.bind(TOK.Profiling, {existing: true})
		const start = vi.fn(async() => undefined)
		const container: Container = {...base, has: () => false}
		await expect(registerProfiling(container, {preset: 'custom', options: {continuous: {
			start,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		}}})).rejects.toThrow('profiling_already_registered')
		expect(start).not.toHaveBeenCalled()
	})

	it('sanitizes container dependency lookup failures and releases registration admission', async() => {
		const base = createContainer()
		const container: Container = {
			...base,
			tryGet: (token) => {
				if (token === TOK.Clock) throw new Error('profiling_password_supersecret')
				return base.tryGet(token)
			}
		}
		const configuration = {preset: 'custom' as const, options: {continuous: {
			start: async() => undefined,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running' as const, healthy: true})
		}}}
		await expect(registerProfiling(container, configuration)).rejects.toThrow('profiling_invalid_registration')
		await expect(registerProfiling(container, configuration)).rejects.not.toThrow('supersecret')
	})

	it('does not trust enum-shaped errors from hostile container methods', async() => {
		const base = createContainer()
		const container: Container = {
			...base,
			has: () => { throw new Error('profiling_password_supersecret') }
		}
		const configuration = {preset: 'custom' as const, options: {continuous: {
			start: async() => undefined,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running' as const, healthy: true})
		}}}
		await expect(registerProfiling(container, configuration)).rejects.toThrow(/^profiling_registration_failed$/u)
		await expect(registerProfiling(container, configuration)).rejects.not.toThrow('supersecret')
	})

	it('observes rejected asynchronous container results before failing closed', async() => {
		const base = createContainer()
		let rejectionObserved = false
		const container: Container = {
			...base,
			has: (() => ({then(_resolve: () => void, reject: (reason: Error) => void) {
				rejectionObserved = true
				reject(new Error('authorization=secret-async-container'))
			}})) as never
		}
		await expect(registerProfiling(container, {preset: 'development'}))
			.rejects.toThrow('profiling_invalid_container')
		await vi.waitFor(() => expect(rejectionObserved).toBe(true))
	})

	it('removes a container binding that an invalid async bind installs late', async() => {
		const base = createContainer()
		let releaseBind!: () => void
		const gate = new Promise<void>((resolve) => { releaseBind = resolve })
		const shutdown = vi.fn(async() => undefined)
		const container: Container = {
			...base,
			bind: (async(token: symbol, value: unknown) => {
				await gate
				base.bind(token, value)
				throw new Error('late bind rejection')
			}) as never
		}
		const registration = registerProfiling(container, {preset: 'custom', options: {continuous: {
			start: async() => undefined,
			shutdown,
			getStatus: () => ({state: 'running', healthy: true})
		}}})

		await expect(registration).rejects.toThrow('profiling_invalid_container')
		expect(shutdown).toHaveBeenCalledOnce()
		releaseBind()
		await vi.waitFor(() => expect(base.has(TOK.Profiling)).toBe(false))
	})

	it('fails closed when the container returns a null lifecycle capability', async() => {
		const base = createContainer()
		const start = vi.fn(async() => undefined)
		const container: Container = {
			...base,
			tryGet: (token) => token === TOK.Lifecycle ? null as never : base.tryGet(token)
		}
		await expect(registerProfiling(container, {preset: 'custom', options: {continuous: {
			start,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		}}})).rejects.toThrow('profiling_registration_failed')
		expect(start).not.toHaveBeenCalled()
	})

	it('fences re-entrant registration before invoking container callbacks', async() => {
		const base = createContainer(); let nested: Promise<void> | undefined; let reentered = false
		const start = vi.fn(async() => undefined)
		const configuration = {preset: 'custom' as const, options: {continuous: {
			start,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running' as const, healthy: true})
		}}}
		const container: Container = {
			...base,
			has: (token) => {
				if (!reentered) {
					reentered = true
					nested = registerProfiling(container, configuration)
					void nested.catch(() => undefined)
				}
				return base.has(token)
			}
		}

		await registerProfiling(container, configuration)
		await expect(nested).rejects.toThrow('profiling_already_registered')
		expect(start).toHaveBeenCalledOnce()
		await container.get<ManagedProfiling>(TOK.Profiling).shutdown()
	})
})
