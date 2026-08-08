import type {CpuProfileArtifact, CpuProfiler, ProfileExporter} from '@ooopsstudio/core/ports/profiling'
import {describe, expect, it, vi} from 'vitest'

import {createProfilingManager} from '../src/manager'
import {createCustomProfiling} from '../src/public/custom'
import {attachProfilingTelemetry} from '../src/runtime-capabilities'

const artifact = (name = 'operation'): CpuProfileArtifact => Object.freeze({
	type: 'cpu', format: 'cpuprofile', name, startedAt: 1, endedAt: 11, durationMs: 10,
	captured: true, payload: '{"nodes":[]}', labels: Object.freeze({route: '/users/:id'}), resource: Object.freeze({})
})

describe('managed profiling runtime', () => {
	it('returns only a frozen summary and exports isolated artifacts in parallel', async() => {
		let release!: () => void
		const barrier = new Promise<void>((resolve) => { release = resolve })
		const profiler: CpuProfiler = {capture: vi.fn(async() => artifact())}
		const first: ProfileExporter = {export: vi.fn(async(profile) => { expect(Object.isFrozen(profile)).toBe(true); await barrier })}
		const second: ProfileExporter = {export: vi.fn(async(profile) => { expect(profile.payload).toContain('nodes'); release() })}
		const runtime = await createProfilingManager({profiler, destinations: [{name: 'first', exporter: first}, {name: 'second', exporter: second}]})
		const result = await runtime.capture({type: 'cpu', labels: {authorization: 'secret'}})
		expect(result).toEqual({type: 'cpu', name: 'operation', startedAt: 1, endedAt: 11, durationMs: 10, captured: true})
		expect(result).not.toHaveProperty('payload'); expect(Object.isFrozen(result)).toBe(true)
		await runtime.shutdown()
	})

	it('sanitizes standard resource fields before exporting an artifact', async() => {
		const exporter: ProfileExporter = {export: vi.fn(async() => undefined)}
		const runtime = await createProfilingManager({
			resource: {
				serviceName: 'operator@example.com',
				serviceVersion: 'authorization=secret-version',
				attributes: {authorization: 'Bearer secret-token'}
			},
			profiler: {capture: async() => artifact()},
			destinations: [{name: 'sink', exporter}]
		})

		await runtime.capture({type: 'cpu'})
		const delivered = vi.mocked(exporter.export).mock.calls[0]?.[0]
		expect(delivered?.resource).toEqual({
			'service.name': '[email]',
			'service.version': 'redacted',
			authorization: 'redacted'
		})
		await runtime.shutdown()
	})

	it('rejects overlap immediately and preserves process-global ownership', async() => {
		let release!: (value: CpuProfileArtifact) => void
		const profiler = {capture: vi.fn(async() => await new Promise<CpuProfileArtifact>((resolve) => { release = resolve }))}
		const exporter = {export: vi.fn(async() => undefined)}
		const one = await createProfilingManager({profiler, destinations: [{name: 'memory', exporter}]})
		const two = await createProfilingManager({profiler: {capture: vi.fn(async() => artifact())}, destinations: [{name: 'memory', exporter}]})
		const active = one.capture({type: 'cpu'})
		await Promise.resolve()
		await expect(two.capture({type: 'cpu'})).resolves.toMatchObject({captured: false, reason: 'capture_in_progress'})
		release(artifact()); await active; await Promise.all([one.shutdown(), two.shutdown()])
	})

	it('preserves manual capture ownership across separately loaded package instances', async() => {
		let release!: (value: CpuProfileArtifact) => void
		const first = await createProfilingManager({
			profiler: {capture: async() => await new Promise<CpuProfileArtifact>((resolve) => { release = resolve })},
			destinations: [{name: 'first', exporter: {export: async() => undefined}}]
		})
		const active = first.capture({type: 'cpu'})
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))

		vi.resetModules()
		const {createProfilingManager: createFromSecondInstance} = await import('../src/manager')
		const secondCapture = vi.fn(async() => artifact())
		const second = await createFromSecondInstance({
			profiler: {capture: secondCapture},
			destinations: [{name: 'second', exporter: {export: async() => undefined}}]
		})

		await expect(second.capture({type: 'cpu'})).resolves.toMatchObject({
			captured: false,
			reason: 'capture_in_progress'
		})
		expect(secondCapture).not.toHaveBeenCalled()
		release(artifact())
		await active
		await Promise.all([first.shutdown(), second.shutdown()])
	})

	it('does not finalize a profiler while another runtime owns CPU capture', async() => {
		let release!: (value: CpuProfileArtifact) => void
		const first = await createProfilingManager({
			profiler: {capture: async() => await new Promise<CpuProfileArtifact>((resolve) => { release = resolve })}
		})
		const shutdown = vi.fn(async() => undefined)
		const second = await createProfilingManager({
			profiler: {capture: async() => artifact(), shutdown}
		})
		const capture = first.capture({type: 'cpu'})
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))

		await expect(second.shutdown()).rejects.toThrow('profiling_shutdown_failed')
		expect(shutdown).not.toHaveBeenCalled()

		release(artifact())
		await capture
		await expect(second.shutdown()).resolves.toBeUndefined()
		expect(shutdown).toHaveBeenCalledOnce()
		await first.shutdown()
	})

	it('keeps CPU ownership while profiler shutdown remains physical', async() => {
		let releaseShutdown!: () => void
		const shutdown = vi.fn(async() => await new Promise<void>((resolve) => { releaseShutdown = resolve }))
		const closing = await createProfilingManager({profiler: {capture: async() => artifact(), shutdown}})
		const competingCapture = vi.fn(async() => artifact())
		const competing = await createProfilingManager({profiler: {capture: competingCapture}})
		const close = closing.shutdown()
		await vi.waitFor(() => expect(releaseShutdown).toBeTypeOf('function'))

		await expect(competing.capture({type: 'cpu'})).resolves.toMatchObject({
			captured: false,
			reason: 'capture_in_progress'
		})
		expect(competingCapture).not.toHaveBeenCalled()

		releaseShutdown()
		await close
		await competing.shutdown()
	})

	it('retains CPU ownership until rejected profiler shutdown is retried successfully', async() => {
		let attempts = 0
		const closing = await createProfilingManager({profiler: {
			capture: async() => artifact(),
			shutdown: async() => { if (++attempts === 1) throw new Error('ambiguous profiler shutdown') }
		}})
		const competingCapture = vi.fn(async() => artifact())
		const competing = await createProfilingManager({profiler: {capture: competingCapture}})

		await expect(closing.shutdown()).rejects.toThrow('profiling_shutdown_failed')
		await expect(competing.capture({type: 'cpu'})).resolves.toMatchObject({
			captured: false,
			reason: 'capture_in_progress'
		})
		expect(competingCapture).not.toHaveBeenCalled()

		await closing.shutdown()
		await expect(competing.capture({type: 'cpu'})).resolves.toMatchObject({captured: true})
		expect(competingCapture).toHaveBeenCalledOnce()
		await competing.shutdown()
	})

	it('does not finalize a manual profiler while continuous profiling owns CPU', async() => {
		const shutdown = vi.fn(async() => undefined)
		const manual = await createProfilingManager({profiler: {capture: async() => artifact(), shutdown}})
		const continuous = await createProfilingManager({continuous: {
			start: async() => undefined,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		}})

		await expect(manual.shutdown()).rejects.toThrow('profiling_shutdown_failed')
		expect(shutdown).not.toHaveBeenCalled()
		await continuous.shutdown()
		await expect(manual.shutdown()).resolves.toBeUndefined()
		expect(shutdown).toHaveBeenCalledOnce()
	})

	it('prevents manual capture while continuous profiling owns the process', async() => {
		const continuous = {
			start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
			getStatus: () => ({state: 'running' as const, healthy: true})
		}
		const continuousRuntime = await createProfilingManager({continuous})
		const capture = vi.fn(async() => artifact())
		const manualRuntime = await createProfilingManager({profiler: {capture}})

		await expect(manualRuntime.capture({type: 'cpu'})).resolves.toMatchObject({
			captured: false,
			reason: 'capture_in_progress'
		})
		expect(capture).not.toHaveBeenCalled()
		await continuousRuntime.shutdown()
		await manualRuntime.shutdown()
	})

	it('prevents continuous startup while manual capture owns the process', async() => {
		let release!: (value: CpuProfileArtifact) => void
		const manualRuntime = await createProfilingManager({
			profiler: {capture: async() => await new Promise<CpuProfileArtifact>((resolve) => { release = resolve })}
		})
		const capture = manualRuntime.capture({type: 'cpu'})
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		const start = vi.fn(async() => undefined)

		await expect(createProfilingManager({continuous: {
			start,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		}})).rejects.toThrow('profiling_continuous_in_progress')
		expect(start).not.toHaveBeenCalled()

		release(artifact())
		await capture
		await manualRuntime.shutdown()
	})

	it('does not let a hung exporter retain CPU ownership after capture settles', async() => {
		vi.useFakeTimers()
		try {
			let releaseExport!: () => void
			const manual = await createProfilingManager({
				profiler: {capture: async() => artifact()},
				destinations: [{name: 'hung', exporter: {
					export: async() => await new Promise<void>((resolve) => { releaseExport = resolve })
				}}],
				operationTimeoutMs: 5
			})
			const capture = manual.capture({type: 'cpu'})
			await vi.advanceTimersByTimeAsync(5)
			await expect(capture).resolves.toMatchObject({captured: true})

			const continuous = {
				start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
				getStatus: () => ({state: 'running' as const, healthy: true})
			}
			const continuousRuntime = await createProfilingManager({continuous})
			expect(continuous.start).toHaveBeenCalledOnce()
			await continuousRuntime.shutdown()

			releaseExport()
			await vi.runAllTimersAsync()
			await manual.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('keeps timed-out physical profiler work owned until it settles', async() => {
		vi.useFakeTimers()
		try {
			let release!: (value: CpuProfileArtifact) => void
			const runtime = await createProfilingManager({
				profiler: {capture: async() => await new Promise((resolve) => { release = resolve })},
				destinations: [{name: 'sink', exporter: {export: async() => undefined}}], operationTimeoutMs: 5
			})
			const capture = runtime.capture({type: 'cpu', durationMs: 1})
			await vi.advanceTimersByTimeAsync(7)
			await expect(capture).resolves.toMatchObject({captured: false, reason: 'capture_failed'})
			expect(runtime.getStatus().activeCapture).toBe(true)
			release(artifact()); await vi.runAllTimersAsync(); await runtime.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('drains an accepted capture through export before shutting down its destination', async() => {
		let release!: (value: CpuProfileArtifact) => void
		const events: string[] = []
		const runtime = await createProfilingManager({
			profiler: {capture: async() => await new Promise<CpuProfileArtifact>((resolve) => { release = resolve })},
			destinations: [{name: 'sink', exporter: {
				export: async() => { events.push('export') },
				shutdown: async() => { events.push('shutdown') }
			}}]
		})

		const capture = runtime.capture({type: 'cpu'})
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		const shutdown = runtime.shutdown()
		release(artifact())

		await expect(capture).resolves.toMatchObject({captured: true})
		await expect(shutdown).resolves.toBeUndefined()
		expect(events).toEqual(['export', 'shutdown'])
	})

	it('does not finalize a destination while its late export is still physical', async() => {
		let releaseExport!: () => void
		const events: string[] = []
		const runtime = await createProfilingManager({
			profiler: {capture: async() => artifact()},
			destinations: [{name: 'sink', exporter: {
				export: async() => { events.push('export-start'); await new Promise<void>((resolve) => { releaseExport = resolve }); events.push('export-end') },
				shutdown: async() => { events.push('shutdown') }
			}}]
		})

		const capture = runtime.capture({type: 'cpu'})
		const shutdown = runtime.shutdown()
		await vi.waitFor(() => expect(releaseExport).toBeTypeOf('function'))
		expect(events).toEqual(['export-start'])
		releaseExport()
		await Promise.all([capture, shutdown])
		expect(events).toEqual(['export-start', 'export-end', 'shutdown'])
	})

	it('does not admit a capture while component flush is running', async() => {
		let releaseFlush!: () => void
		let flushCalls = 0
		const capture = vi.fn(async() => artifact())
		const runtime = await createProfilingManager({
			profiler: {
				capture,
				flush: async() => {
					if (++flushCalls === 1) await new Promise<void>((resolve) => { releaseFlush = resolve })
				}
			},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})

		const flush = runtime.flush()
		await vi.waitFor(() => expect(releaseFlush).toBeTypeOf('function'))
		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({
			captured: false,
			reason: 'capture_in_progress'
		})
		expect(capture).not.toHaveBeenCalled()

		releaseFlush()
		await flush
		await runtime.shutdown()
	})

	it('retains flush admission after timeout until physical flush settles', async() => {
		vi.useFakeTimers()
		try {
			let releaseFlush!: () => void
			let flushCalls = 0
			const capture = vi.fn(async() => artifact())
			const runtime = await createProfilingManager({
				profiler: {capture, flush: async() => {
					if (++flushCalls === 1) await new Promise<void>((resolve) => { releaseFlush = resolve })
				}},
				destinations: [{name: 'sink', exporter: {export: async() => undefined}}],
				operationTimeoutMs: 5
			})
			const flush = runtime.flush()
			const failedFlush = expect(flush).rejects.toThrow('profiling_flush_failed')
			await vi.advanceTimersByTimeAsync(5)
			await failedFlush

			await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: false, reason: 'capture_in_progress'})
			expect(capture).not.toHaveBeenCalled()
			releaseFlush()
			await vi.runAllTimersAsync()
			await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: true})
			await runtime.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('still shuts down a component after its terminal flush rejects', async() => {
		let physicallyActive = true
		const shutdown = vi.fn(async() => { physicallyActive = false })
		const runtime = await createProfilingManager({
			profiler: {
				capture: async() => artifact(),
				flush: async() => { throw new Error('authorization=secret-flush') },
				shutdown
			},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})

		await expect(runtime.shutdown()).rejects.toThrow('profiling_shutdown_failed')
		expect(shutdown).toHaveBeenCalledOnce()
		expect(physicallyActive).toBe(false)
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('serializes terminal shutdown behind a timed-out physical flush', async() => {
		vi.useFakeTimers()
		try {
			let releaseFlush!: () => void
			const events: string[] = []
			const runtime = await createProfilingManager({
				profiler: {
					capture: async() => artifact(),
					flush: async() => { events.push('flush'); await new Promise<void>((resolve) => { releaseFlush = resolve }) },
					shutdown: async() => { events.push('shutdown') }
				},
				destinations: [{name: 'sink', exporter: {export: async() => undefined}}],
				operationTimeoutMs: 5,
				shutdownTimeoutMs: 5
			})

			const shutdown = runtime.shutdown()
			const failed = expect(shutdown).rejects.toThrow('profiling_shutdown_failed')
			await vi.advanceTimersByTimeAsync(10)
			await failed
			expect(events).toEqual(['flush'])

			releaseFlush()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(events).toEqual(['flush', 'shutdown']))
			await runtime.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('closes admission before retryable bounded shutdown', async() => {
		let finish!: () => void
		const exporter = {export: async() => undefined, shutdown: async() => await new Promise<void>((resolve) => { finish = resolve })}
		const runtime = await createProfilingManager({profiler: {capture: async() => artifact()}, destinations: [{name: 'sink', exporter}], shutdownTimeoutMs: 10})
		await expect(runtime.shutdown()).rejects.toThrow(); expect(runtime.getStatus()).toMatchObject({state: 'draining', sinkState: 'unhealthy'})
		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: false, reason: 'profiling_shutdown'})
		finish(); await Promise.resolve(); await runtime.shutdown(); expect(runtime.getStatus().state).toBe('closed')
	})

	it('validates hard composition rules', async() => {
		await expect(createCustomProfiling({} as never)).rejects.toThrow('requires_capability')
		await expect(createCustomProfiling({profiler: {capture: async() => artifact()}})).rejects.toThrow('requires_destination')
		await expect(createProfilingManager({
			profiler: {capture: async() => artifact()},
			continuous: {
				start: async() => undefined, shutdown: async() => undefined,
				getStatus: () => ({state: 'running', healthy: true})
			}
		})).rejects.toThrow('profiling_invalid_capabilities')
		await expect(createProfilingManager({profiler: {capture: async() => artifact()}, destinations: [0, 1, 2].map((index) => ({name: `sink${index}`, exporter: {export: async() => undefined}}))})).rejects.toThrow('destinations')
		await expect(createProfilingManager({continuous: {
			start: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		} as never})).rejects.toThrow('profiling_invalid_continuous')
	})

	it('enforces one managed continuous profiler across runtime instances', async() => {
		const continuous = () => {
			let state: 'idle' | 'running' | 'closed' = 'idle'
			return {
				start: vi.fn(async() => { state = 'running' }),
				shutdown: vi.fn(async() => { state = 'closed' }),
				getStatus: () => ({state, healthy: state === 'running'})
			}
		}
		const firstProvider = continuous(); const secondProvider = continuous()
		const first = await createProfilingManager({continuous: firstProvider})
		vi.resetModules()
		const {createProfilingManager: createFromSecondInstance} = await import('../src/manager')
		await expect(createFromSecondInstance({continuous: secondProvider})).rejects.toThrow('continuous_in_progress')
		expect(secondProvider.start).not.toHaveBeenCalled()
		await first.shutdown()
		const second = await createFromSecondInstance({continuous: secondProvider})
		await second.shutdown()
	})

	it('retains continuous ownership until retryable shutdown succeeds', async() => {
		let state: 'idle' | 'running' | 'closed' = 'idle'; let shutdownCalls = 0
		const first = await createProfilingManager({continuous: {
			start: async() => { state = 'running' },
			shutdown: async() => { if (++shutdownCalls === 1) throw new Error('ambiguous stop'); state = 'closed' },
			getStatus: () => ({state, healthy: state === 'running'})
		}})
		const replacement = {
			start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
			getStatus: () => ({state: 'running' as const, healthy: true})
		}

		await expect(first.shutdown()).rejects.toThrow('profiling_shutdown_failed')
		await expect(createProfilingManager({continuous: replacement})).rejects.toThrow('continuous_in_progress')
		await first.shutdown()
		const second = await createProfilingManager({continuous: replacement})
		await second.shutdown()
	})

	it('releases continuous ownership when only an unrelated exporter remains hung', async() => {
		vi.useFakeTimers()
		try {
			let releaseExporter!: () => void
			let continuousState: 'idle' | 'running' | 'closed' = 'idle'
			const first = await createProfilingManager({
				continuous: {
					start: async() => { continuousState = 'running' },
					shutdown: async() => { continuousState = 'closed' },
					getStatus: () => ({state: continuousState, healthy: continuousState === 'running'})
				},
				destinations: [{name: 'hung', exporter: {
					export: async() => undefined,
					shutdown: async() => await new Promise<void>((resolve) => { releaseExporter = resolve })
				}}],
				shutdownTimeoutMs: 5
			})
			const failedShutdown = expect(first.shutdown()).rejects.toThrow('profiling_shutdown_failed')
			await vi.advanceTimersByTimeAsync(5)
			await failedShutdown
			expect(continuousState).toBe('closed')

			const replacementProvider = {
				start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
				getStatus: () => ({state: 'running' as const, healthy: true})
			}
			const replacement = await createProfilingManager({continuous: replacementProvider}).catch((error: unknown) => error)
			releaseExporter(); await vi.runAllTimersAsync(); await first.shutdown()
			expect(replacement).not.toBeInstanceOf(Error)
			if (!(replacement instanceof Error)) await replacement.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('snapshots destinations without invoking caller-controlled iterators or accessors', async() => {
		let iteratorReads = 0
		const destinations = [{name: 'sink', exporter: {export: async() => undefined}}]
		Object.defineProperty(destinations, Symbol.iterator, {
			value: () => { iteratorReads++; throw new Error('authorization=secret-iterator') }
		})
		const runtime = await createProfilingManager({profiler: {capture: async() => artifact()}, destinations})
		expect(iteratorReads).toBe(0)
		await runtime.shutdown()

		let accessorReads = 0
		const hostile = [{
			get name(): string { accessorReads++; throw new Error('authorization=secret-name') },
			exporter: {export: async() => undefined}
		}]
		await expect(createProfilingManager({destinations: hostile})).rejects.toThrow('profiling_invalid_destinations')
		expect(accessorReads).toBe(0)
	})

	it('rejects accessor configuration and capture fields without executing them', async() => {
		let reads = 0
		const hostile = Object.defineProperty({}, 'profiler', {enumerable: true, get() { reads++; return undefined }})
		await expect(createCustomProfiling(hostile as never)).rejects.toThrow('invalid_options')
		const runtime = await createProfilingManager({profiler: {capture: async() => artifact()}, destinations: [{name: 'sink', exporter: {export: async() => undefined}}]})
		const capture = Object.defineProperty({type: 'cpu'}, 'labels', {enumerable: true, get() { reads++; return {} }})
		await expect(runtime.capture(capture as never)).rejects.toThrow('capture_options')
		expect(reads).toBe(0); await runtime.shutdown()
	})

	it('fails closed for null standard capabilities before creating a custom runtime', async() => {
		const base = {
			profiler: {capture: async() => artifact()},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		}
		for (const [field, code] of [
			['clock', 'profiling_invalid_clock'],
			['resource', 'profiling_invalid_resource'],
			['lifecycle', 'PROFILING_LIFECYCLE_REGISTRATION_FAILURE']
		] as const) {
			await expect(createCustomProfiling({...base, [field]: null} as never)).rejects.toThrow(code)
		}
	})

	it('rejects injected capability method accessors without executing them', async() => {
		let reads = 0
		const hostileProfiler = Object.defineProperty({}, 'capture', {
			enumerable: true,
			get() { reads++; return async() => artifact() }
		})
		await expect(createProfilingManager({profiler: hostileProfiler as CpuProfiler})).rejects.toThrow('profiling_invalid_profiler')

		const hostileLifecycle = Object.defineProperty({}, 'registerFlushHook', {
			enumerable: true,
			get() { reads++; return () => () => undefined }
		})
		await expect(createProfilingManager({lifecycle: hostileLifecycle as never})).rejects.toThrow('PROFILING_LIFECYCLE_REGISTRATION_FAILURE')
		expect(reads).toBe(0)
	})

	it('rejects continuous status accessors without executing them', async() => {
		let reads = 0
		const status = Object.defineProperty({healthy: true}, 'state', {
			enumerable: true,
			get() { reads++; return 'running' }
		})
		const shutdown = vi.fn(async() => undefined)
		await expect(createProfilingManager({continuous: {
			start: async() => undefined,
			shutdown,
			getStatus: () => status as never
		}})).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
		expect(reads).toBe(0)
		expect(shutdown).toHaveBeenCalled()
	})

	it('observes a rejected asynchronous continuous status before failing startup', async() => {
		let rejectionObserved = 0
		const shutdown = vi.fn(async() => undefined)
		await expect(createProfilingManager({continuous: {
			start: async() => undefined,
			shutdown,
			getStatus: () => ({
				then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
					rejectionObserved++
					reject(new Error('async status failure'))
				}
			}) as never
		}})).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
		await vi.waitFor(() => expect(rejectionObserved).toBe(1))
		expect(shutdown).toHaveBeenCalled()
	})

	it('snapshots custom profiler artifacts before validation and export', async() => {
		let payloadReads = 0
		const hostile = Object.defineProperty({...artifact()}, 'payload', {
			enumerable: true,
			get() { payloadReads++; return payloadReads === 1 ? '{"nodes":[]}' : 'x'.repeat(65 * 1024 * 1024) }
		})
		const exporter = {export: vi.fn(async() => undefined)}
		const runtime = await createProfilingManager({
			profiler: {capture: async() => hostile as CpuProfileArtifact},
			destinations: [{name: 'sink', exporter}]
		})

		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: false, reason: 'capture_failed'})
		expect(payloadReads).toBe(0)
		expect(exporter.export).not.toHaveBeenCalled()
		await runtime.shutdown()
	})

	it('rejects payloads longer than the byte budget before scanning UTF-8 bytes', async() => {
		const payload = 'x'.repeat(9)
		const byteLength = vi.spyOn(Buffer, 'byteLength')
		const runtime = await createProfilingManager({
			profiler: {capture: async() => ({...artifact(), payload})},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}],
			maxPayloadBytes: 8
		})

		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({
			captured: false,
			reason: 'profile_too_large'
		})
		expect(byteLength.mock.calls.some(([value]) => value === payload)).toBe(false)
		byteLength.mockRestore()
		await runtime.shutdown()
	})

	it('enforces UTF-8 payload limits with a rewired global Buffer', async() => {
		vi.stubGlobal('Buffer', {byteLength: () => 0})
		try {
			const runtime = await createProfilingManager({
				profiler: {capture: async() => ({...artifact(), payload: '€'})},
				destinations: [{name: 'sink', exporter: {export: async() => undefined}}],
				maxPayloadBytes: 2
			})
			await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({
				captured: false,
				reason: 'profile_too_large'
			})
			await runtime.shutdown()
		} finally { vi.unstubAllGlobals() }
	})

	it('reads only bounded known fields from custom profiler artifacts', async() => {
		let enumerations = 0
		const target = {...artifact()}
		const hostile = new Proxy(target, {
			ownKeys() { enumerations++; throw new Error('unbounded enumeration attempted') }
		})
		const exporter = {export: vi.fn(async() => undefined)}
		const runtime = await createProfilingManager({
			profiler: {capture: async() => hostile},
			destinations: [{name: 'sink', exporter}]
		})

		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: true})
		expect(enumerations).toBe(0)
		expect(exporter.export).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('accepts successful profiler artifacts without optional labels', async() => {
		const unlabeled = {...artifact()}
		delete (unlabeled as {labels?: Readonly<Record<string, string>>}).labels
		const exporter = {export: vi.fn(async() => undefined)}
		const runtime = await createProfilingManager({
			profiler: {capture: async() => unlabeled},
			destinations: [{name: 'sink', exporter}]
		})

		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: true})
		expect(exporter.export).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('sanitizes clock failures at the public capture boundary', async() => {
		const runtime = await createProfilingManager({
			clock: {now: () => { throw new Error('authorization=secret-clock') }},
			profiler: {capture: async() => artifact()},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})
		await expect(runtime.capture({type: 'cpu'})).rejects.toThrow('profiling_invalid_clock')
		await expect(runtime.capture({type: 'cpu'})).rejects.not.toThrow('secret-clock')
		await runtime.shutdown()
	})

	it('observes a rejected asynchronous clock result before failing closed', async() => {
		let rejectionObserved = false
		const runtime = await createProfilingManager({
			clock: {now: (() => ({then(_resolve: () => void, reject: (reason: Error) => void) {
				rejectionObserved = true
				reject(new Error('authorization=secret-async-clock'))
			}})) as never},
			profiler: {capture: async() => artifact()},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})

		await expect(runtime.capture({type: 'cpu'})).rejects.toThrow('profiling_invalid_clock')
		await vi.waitFor(() => expect(rejectionObserved).toBe(true))
		await runtime.shutdown()
	})

	it('does not inspect hostile profiler rejection prototypes', async() => {
		let prototypeReads = 0
		const rejection = new Proxy({}, {
			getPrototypeOf() { prototypeReads++; throw new Error('authorization=secret-rejection') }
		})
		const runtime = await createProfilingManager({
			profiler: {capture: async() => await Promise.reject(rejection)},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})

		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: false, reason: 'capture_failed'})
		expect(prototypeReads).toBe(0)
		await runtime.shutdown()
	})

	it('does not retain process ownership when capture controller setup fails', async() => {
		const runtime = await createProfilingManager({
			profiler: {capture: async() => artifact()},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})
		try {
			vi.stubGlobal('AbortController', class { constructor() { throw new Error('controller setup failed') } })
			await expect(runtime.capture({type: 'cpu'})).rejects.toThrow('controller setup failed')
		} finally { vi.unstubAllGlobals() }
		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: true})
		await runtime.shutdown()
	})

	it('reserves process ownership before invoking an injected clock', async() => {
		let runtime!: Awaited<ReturnType<typeof createProfilingManager>>
		let nested: Promise<unknown> | undefined; let reentered = false
		const capture = vi.fn(async() => artifact())
		runtime = await createProfilingManager({
			clock: {now: () => {
				if (!reentered) { reentered = true; nested = runtime.capture({type: 'cpu'}) }
				return 1
			}},
			profiler: {capture},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})

		await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({captured: true})
		await expect(nested).rejects.toThrow('profiling_invalid_clock')
		expect(capture).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('reserves process ownership before traversing caller labels', async() => {
		let runtime!: Awaited<ReturnType<typeof createProfilingManager>>
		let nested: Promise<unknown> | undefined; let reentered = false
		const capture = vi.fn(async() => artifact())
		const labels = new Proxy({}, {
			ownKeys() {
				if (!reentered) { reentered = true; nested = runtime.capture({type: 'cpu'}) }
				return []
			}
		})
		runtime = await createProfilingManager({
			clock: {now: () => 1},
			profiler: {capture},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})

		await expect(runtime.capture({type: 'cpu', labels})).resolves.toMatchObject({captured: true})
		await expect(nested).resolves.toMatchObject({captured: false, reason: 'capture_in_progress'})
		expect(capture).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('does not start a capture after caller-controlled option inspection begins shutdown', async() => {
		let runtime!: Awaited<ReturnType<typeof createProfilingManager>>
		let shutdown: Promise<void> | undefined
		const capture = vi.fn(async() => artifact())
		const labels = new Proxy({}, {
			ownKeys() {
				shutdown ??= runtime.shutdown()
				return []
			}
		})
		runtime = await createProfilingManager({
			clock: {now: () => 1},
			profiler: {capture, shutdown: async() => undefined},
			destinations: [{name: 'sink', exporter: {export: async() => undefined, shutdown: async() => undefined}}]
		})

		await expect(runtime.capture({type: 'cpu', labels})).resolves.toMatchObject({
			captured: false,
			reason: 'profiling_shutdown'
		})
		await shutdown
		expect(capture).not.toHaveBeenCalled()
		expect(runtime.getStatus().state).toBe('closed')
	})

	it('suppresses recursive telemetry dispatch', async() => {
		const runtime = await createProfilingManager({
			clock: {now: () => 1},
			profiler: {capture: async() => artifact()},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})
		const nested: Array<Promise<unknown>> = []; let observations = 0
		const dispose = attachProfilingTelemetry(runtime, () => {
			observations++
			nested.push(runtime.capture({type: 'cpu'}))
		})

		await runtime.capture({type: 'cpu'})
		await Promise.all(nested)
		expect(observations).toBe(3)
		expect(nested).toHaveLength(3)
		dispose()
		await runtime.shutdown()
	})

	it('registers physical capture before capture-start telemetry can request shutdown', async() => {
		const events: string[] = []
		const runtime = await createProfilingManager({
			clock: {now: () => 1},
			profiler: {
				capture: async() => { events.push('capture'); return artifact() },
				shutdown: async() => { events.push('profiler-shutdown') }
			},
			destinations: [{name: 'sink', exporter: {
				export: async() => { events.push('export') },
				shutdown: async() => { events.push('exporter-shutdown') }
			}}]
		})
		let shutdown: Promise<void> | undefined
		const dispose = attachProfilingTelemetry(runtime, (event) => {
			if (event.kind === 'capture_started') shutdown = runtime.shutdown()
		})

		await runtime.capture({type: 'cpu'})
		await shutdown
		expect(events).toEqual(['capture', 'export', 'profiler-shutdown', 'exporter-shutdown'])
		dispose()
	})

	it('keeps status frozen and sanitized after custom failures', async() => {
		const runtime = await createProfilingManager({profiler: {capture: async() => { throw new Error('credential=secret') }}, destinations: [{name: 'sink', exporter: {export: async() => undefined}}]})
		await runtime.capture({type: 'cpu'})
		const status = runtime.getStatus(); expect(Object.isFrozen(status)).toBe(true); expect(JSON.stringify(status)).not.toContain('secret')
		await runtime.shutdown()
	})

	it('sanitizes continuous startup failures and still runs cleanup', async() => {
		const shutdown = vi.fn(async() => undefined)
		const disposeFlush = vi.fn(); const disposeShutdown = vi.fn()
		const creation = createProfilingManager({continuous: {
			start: async() => { throw new Error('authorization=secret-continuous') },
			shutdown,
			getStatus: () => ({state: 'idle', healthy: false})
		}, lifecycle: {
			registerFlushHook: () => disposeFlush,
			registerShutdownHook: () => disposeShutdown
		} as never})
		await expect(creation).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
		await expect(creation).rejects.not.toThrow('secret-continuous')
		expect(shutdown).toHaveBeenCalledOnce()
		expect(disposeFlush).toHaveBeenCalledOnce()
		expect(disposeShutdown).toHaveBeenCalledOnce()
	})

	it('awaits rejected asynchronous disposers during continuous startup rollback', async() => {
		const disposeFlush = vi.fn(async() => await Promise.reject(new Error('async flush disposer failure')))
		const disposeShutdown = vi.fn(async() => await Promise.reject(new Error('async shutdown disposer failure')))
		await expect(createProfilingManager({
			continuous: {
				start: async() => { throw new Error('start failure') },
				shutdown: async() => undefined,
				getStatus: () => ({state: 'idle', healthy: false})
			},
			lifecycle: {
				registerFlushHook: () => disposeFlush,
				registerShutdownHook: () => disposeShutdown
			} as never
		})).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
		expect(disposeFlush).toHaveBeenCalledOnce()
		expect(disposeShutdown).toHaveBeenCalledOnce()
	})

	it('cleans up hostile continuous rejections without prototype inspection', async() => {
		let prototypeReads = 0; let physicallyActive = false
		const rejection = new Proxy({}, {
			getPrototypeOf() { prototypeReads++; throw new Error('authorization=secret-continuous-rejection') }
		})
		const shutdown = vi.fn(async() => { physicallyActive = false })
		await expect(createProfilingManager({continuous: {
			start: async() => { physicallyActive = true; await Promise.reject(rejection) },
			shutdown,
			getStatus: () => ({state: 'idle', healthy: false})
		}})).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
		expect(prototypeReads).toBe(0)
		expect(shutdown).toHaveBeenCalled()
		expect(physicallyActive).toBe(false)
	})

	it('retries cleanup and sanitizes lifecycle registration failures', async() => {
		let attempts = 0
		const dispose = vi.fn()
		const creation = createProfilingManager({
			continuous: {
				start: async() => undefined,
				shutdown: async() => { if (++attempts === 1) throw new Error('transient cleanup') },
				getStatus: () => ({state: 'idle', healthy: true})
			},
			lifecycle: {
				registerFlushHook: () => dispose,
				registerShutdownHook: () => { throw new Error('authorization=secret-lifecycle') }
			} as never
		})
		await expect(creation).rejects.toThrow('PROFILING_LIFECYCLE_REGISTRATION_FAILURE')
		await expect(creation).rejects.not.toThrow('secret-lifecycle')
		expect(attempts).toBe(2)
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('releases an unstarted continuous reservation when lifecycle cleanup keeps failing', async() => {
		const shutdown = vi.fn(async() => { throw new Error('persistent cleanup failure') })
		await expect(createProfilingManager({
			continuous: {
				start: vi.fn(async() => undefined), shutdown,
				getStatus: () => ({state: 'idle', healthy: false})
			},
			lifecycle: {
				registerFlushHook: () => () => undefined,
				registerShutdownHook: () => { throw new Error('registration failed') }
			} as never
		})).rejects.toThrow('PROFILING_LIFECYCLE_REGISTRATION_FAILURE')
		expect(shutdown).toHaveBeenCalledTimes(2)

		const replacement = {
			start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
			getStatus: () => ({state: 'running' as const, healthy: true})
		}
		const runtime = await createProfilingManager({continuous: replacement})
		await runtime.shutdown()
	})

	it('observes rejected asynchronous lifecycle registration results', async() => {
		let rejectionObserved = false
		const creation = createProfilingManager({lifecycle: {
			registerFlushHook: (() => ({then(_resolve: () => void, reject: (reason: Error) => void) {
				rejectionObserved = true
				reject(new Error('authorization=secret-async-lifecycle'))
			}})) as never,
			registerShutdownHook: vi.fn()
		} as never})

		await expect(creation).rejects.toThrow('PROFILING_LIFECYCLE_REGISTRATION_FAILURE')
		expect(rejectionObserved).toBe(true)
	})

	it('rejects a hanging asynchronous lifecycle registration without retaining ownership', async() => {
		let state: 'idle' | 'running' | 'closed' = 'idle'
		const shutdown = vi.fn(async() => { state = 'closed' })
		await expect(createProfilingManager({
			continuous: {
				start: async() => { state = 'running' },
				shutdown,
				getStatus: () => ({state, healthy: state === 'running'})
			},
			lifecycle: {
				registerFlushHook: (() => new Promise<void>(() => undefined)) as never,
				registerShutdownHook: vi.fn()
			} as never
		})).rejects.toThrow('PROFILING_LIFECYCLE_REGISTRATION_FAILURE')
		expect(shutdown).toHaveBeenCalledOnce()

		const replacement = {
			start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
			getStatus: () => ({state: 'running' as const, healthy: true})
		}
		const runtime = await createProfilingManager({continuous: replacement})
		await runtime.shutdown()
	})

	it('awaits and contains rejected asynchronous lifecycle disposers', async() => {
		let entered = false
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const disposeFlush = vi.fn(async() => undefined)
		const runtime = await createProfilingManager({lifecycle: {
			registerFlushHook: () => disposeFlush,
			registerShutdownHook: () => async() => {
				entered = true
				await gate
				throw new Error('async disposer failure')
			}
		} as never})

		let settled = false
		const shutdown = runtime.shutdown().then(() => { settled = true })
		await vi.waitFor(() => expect(entered).toBe(true))
		expect(settled).toBe(false)
		release()
		await expect(shutdown).resolves.toBeUndefined()
		expect(disposeFlush).toHaveBeenCalledOnce()
	})

	it('bounds a hanging lifecycle disposer and continues terminal cleanup', async() => {
		const disposeFlush = vi.fn(async() => undefined)
		const runtime = await createProfilingManager({
			operationTimeoutMs: 1,
			lifecycle: {
				registerFlushHook: () => disposeFlush,
				registerShutdownHook: () => async() => await new Promise<void>(() => undefined)
			} as never
		})
		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(disposeFlush).toHaveBeenCalledOnce()
		expect(runtime.getStatus()).toMatchObject({state: 'closed'})
	})

	it('does not start continuous profiling after a lifecycle hook begins shutdown during construction', async() => {
		const start = vi.fn(async() => undefined)
		let lifecycleShutdown: Promise<void> | undefined
		const creation = createProfilingManager({
			continuous: {
				start,
				shutdown: async() => undefined,
				getStatus: () => ({state: 'running', healthy: true})
			},
			lifecycle: {
				registerFlushHook: () => () => undefined,
				registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
					lifecycleShutdown = hook()
					return () => undefined
				}
			} as never
		})

		await expect(creation).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
		await lifecycleShutdown
		expect(start).not.toHaveBeenCalled()
	})

	it('does not report lifecycle shutdown complete while an accepted continuous start is pending', async() => {
		vi.useFakeTimers()
		try {
			let releaseStart!: () => void
			let shutdownHook!: () => Promise<void>
			let physicallyActive = false
			const shutdown = vi.fn(async() => { physicallyActive = false })
			const creation = createProfilingManager({
				continuous: {
					start: async() => {
						await new Promise<void>((resolve) => { releaseStart = resolve })
						physicallyActive = true
					},
					shutdown,
					getStatus: () => ({state: 'starting', healthy: true})
				},
				lifecycle: {
					registerFlushHook: () => () => undefined,
					registerShutdownHook: (_group: string, hook: () => Promise<void>) => {
						shutdownHook = hook
						return () => undefined
					}
				} as never,
				operationTimeoutMs: 100,
				shutdownTimeoutMs: 5
			})
			const creationResult = creation.then(() => undefined, (error: unknown) => error)
			await vi.advanceTimersByTimeAsync(0)
			expect(releaseStart).toBeTypeOf('function')

			const lifecycleShutdown = shutdownHook()
			const lifecycleResult = lifecycleShutdown.then(() => undefined, (error: unknown) => error)
			await vi.advanceTimersByTimeAsync(5)
			expect(await lifecycleResult).toMatchObject({message: 'PROFILING_DRAIN_TIMEOUT'})
			expect(shutdown).not.toHaveBeenCalled()

			releaseStart()
			await vi.runAllTimersAsync()
			expect(await creationResult).toMatchObject({message: 'PROFILING_CONTINUOUS_START_FAILURE'})
			expect(physicallyActive).toBe(false)
			expect(shutdown).toHaveBeenCalled()
		} finally { vi.useRealTimers() }
	})

	it('attempts immediate cleanup when continuous startup times out physically active', async() => {
		vi.useFakeTimers()
		try {
			let releaseStart!: () => void
			let physicallyActive = false
			const shutdown = vi.fn(async() => { physicallyActive = false })
			const creation = createProfilingManager({
				continuous: {
					start: async() => { physicallyActive = true; await new Promise<void>((resolve) => { releaseStart = resolve }) },
					shutdown,
					getStatus: () => ({state: 'starting', healthy: true})
				},
				operationTimeoutMs: 5,
				shutdownTimeoutMs: 5
			})
			const failed = expect(creation).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
			await vi.advanceTimersByTimeAsync(5)
			expect(shutdown).toHaveBeenCalledOnce()
			expect(physicallyActive).toBe(false)
			await vi.advanceTimersByTimeAsync(10)
			await failed
			releaseStart(); await vi.runAllTimersAsync()
		} finally { vi.useRealTimers() }
	})

	it('releases continuous ownership after rejected construction finishes late cleanup', async() => {
		vi.useFakeTimers()
		try {
			let releaseStart!: () => void
			const creation = createProfilingManager({
				continuous: {
					start: async() => await new Promise<void>((resolve) => { releaseStart = resolve }),
					shutdown: async() => undefined,
					getStatus: () => ({state: 'starting', healthy: true})
				},
				operationTimeoutMs: 5,
				shutdownTimeoutMs: 5
			})
			const failed = expect(creation).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
			await vi.advanceTimersByTimeAsync(15)
			await failed
			const replacement = {
				start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
				getStatus: () => ({state: 'running' as const, healthy: true})
			}
			await expect(createProfilingManager({continuous: replacement})).rejects.toThrow('continuous_in_progress')

			releaseStart(); await vi.runAllTimersAsync(); await Promise.resolve()
			const recovered = await createProfilingManager({continuous: replacement})
			await recovered.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('retries ambiguous early cleanup while continuous start remains hung', async() => {
		vi.useFakeTimers()
		try {
			let releaseStart!: () => void
			let physicallyActive = false; let attempts = 0
			const creation = createProfilingManager({
				continuous: {
					start: async() => { physicallyActive = true; await new Promise<void>((resolve) => { releaseStart = resolve }) },
					shutdown: async() => { if (++attempts === 1) throw new Error('ambiguous stop'); physicallyActive = false },
					getStatus: () => ({state: 'starting', healthy: true})
				},
				operationTimeoutMs: 5,
				shutdownTimeoutMs: 5
			})
			const failed = expect(creation).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
			await vi.advanceTimersByTimeAsync(5)
			expect(attempts).toBe(2)
			expect(physicallyActive).toBe(false)
			await vi.advanceTimersByTimeAsync(10)
			await failed
			releaseStart(); await vi.runAllTimersAsync()
		} finally { vi.useRealTimers() }
	})

	it('runs late continuous fencing without waiting for a hung early shutdown', async() => {
		vi.useFakeTimers()
		try {
			let releaseStart!: () => void
			let releaseEarlyShutdown!: () => void
			let physicallyActive = false; let attempts = 0
			const creation = createProfilingManager({
				continuous: {
					start: async() => { physicallyActive = true; await new Promise<void>((resolve) => { releaseStart = resolve }) },
					shutdown: async() => {
						if (++attempts === 1) await new Promise<void>((resolve) => { releaseEarlyShutdown = resolve })
						physicallyActive = false
					},
					getStatus: () => ({state: 'starting', healthy: true})
				},
				operationTimeoutMs: 5,
				shutdownTimeoutMs: 5
			})
			const failed = expect(creation).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
			await vi.advanceTimersByTimeAsync(5)
			expect(attempts).toBe(1)
			releaseStart()
			await vi.advanceTimersByTimeAsync(0)
			expect(attempts).toBe(2)
			expect(physicallyActive).toBe(false)
			await vi.advanceTimersByTimeAsync(5)
			await failed
			releaseEarlyShutdown(); await vi.runAllTimersAsync()
		} finally { vi.useRealTimers() }
	})

	it('uses an independent cleanup retry when startup rollback shutdown hangs', async() => {
		vi.useFakeTimers()
		try {
			let releaseShutdown!: () => void
			let physicallyActive = false; let attempts = 0
			const creation = createProfilingManager({
				continuous: {
					start: async() => { physicallyActive = true; throw new Error('ambiguous start') },
					shutdown: async() => {
						if (++attempts === 1) await new Promise<void>((resolve) => { releaseShutdown = resolve })
						physicallyActive = false
					},
					getStatus: () => ({state: 'idle', healthy: false})
				},
				operationTimeoutMs: 5,
				shutdownTimeoutMs: 5
			})
			const failed = expect(creation).rejects.toThrow('PROFILING_CONTINUOUS_START_FAILURE')
			await vi.advanceTimersByTimeAsync(5)
			expect(attempts).toBe(2)
			expect(physicallyActive).toBe(false)
			await failed
			releaseShutdown(); await vi.runAllTimersAsync()
		} finally { vi.useRealTimers() }
	})
})
