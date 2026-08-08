import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => {
	class MockSession {
		static payload: unknown = {nodes: []}; static posts: string[] = []; static disconnectFails = false
		static disconnects = 0
		static stopFailuresRemaining = 0; static disconnectFailuresRemaining = 0
		static profileAccessor = false; static profileAccessorReads = 0
		static blockedMethod: string | undefined; static releasePost: (() => void) | undefined
		connect() {}; disconnect() {
			MockSession.disconnects++
			if (MockSession.disconnectFails || MockSession.disconnectFailuresRemaining-- > 0) throw new Error('disconnect failed')
		}
		async post(method: string) {
			MockSession.posts.push(method)
			if (MockSession.blockedMethod === method) await new Promise<void>((resolve) => { MockSession.releasePost = resolve })
			if (method === 'Profiler.stop' && MockSession.stopFailuresRemaining-- > 0) throw new Error('stop failed')
			return method === 'Profiler.stop'
				? MockSession.profileAccessor
					? Object.defineProperty({}, 'profile', {get() { MockSession.profileAccessorReads++; return MockSession.payload }})
					: {profile: MockSession.payload}
				: {}
		}
	}
	return {MockSession}
})
vi.mock('node:inspector/promises', () => ({Session: mocks.MockSession}))

import {createLazyInspectorProfiler} from '../src/lazy-inspector-profiler'
import {createProfilingManager} from '../src/manager'
import {createInspectorProfiler} from '../src/profilers-inspector'

describe('Inspector CPU profiler', () => {
	beforeEach(() => {
		mocks.MockSession.payload = {nodes: []}; mocks.MockSession.posts = []
		mocks.MockSession.disconnectFails = false; mocks.MockSession.blockedMethod = undefined
		mocks.MockSession.disconnects = 0
		mocks.MockSession.stopFailuresRemaining = 0; mocks.MockSession.disconnectFailuresRemaining = 0
		mocks.MockSession.profileAccessor = false; mocks.MockSession.profileAccessorReads = 0
		mocks.MockSession.releasePost = undefined
	})
	it('captures CPU only and never invokes HeapProfiler', async() => {
		const profiler = createInspectorProfiler({clock: {now: () => 1}}); await expect(profiler.capture({type: 'cpu', durationMs: 1})).resolves.toMatchObject({type: 'cpu', format: 'cpuprofile', captured: true})
		expect(mocks.MockSession.posts.join(' ')).not.toContain('HeapProfiler'); await expect(profiler.capture({type: 'heap'} as never)).rejects.toThrow('cpu_only')
	})
	it('keeps the capture-duration timer referenced until the profile completes', async() => {
		const probe = setTimeout(() => undefined, 1)
		const unref = vi.spyOn(Object.getPrototypeOf(probe) as {unref(): unknown}, 'unref')
		clearTimeout(probe)
		try {
			await createInspectorProfiler({clock: {now: () => 1}}).capture({type: 'cpu', durationMs: 1})
			expect(unref).not.toHaveBeenCalled()
		} finally { unref.mockRestore() }
	})
	it('rejects oversized payloads and invalid limits', async() => { mocks.MockSession.payload = {secret: 'large'}; await expect(createInspectorProfiler({maxPayloadBytes: 2}).capture({type: 'cpu', durationMs: 1})).rejects.toThrow('profile_too_large'); expect(() => createInspectorProfiler(null as never)).toThrow('invalid_options'); expect(() => createInspectorProfiler([] as never)).toThrow('invalid_options'); expect(() => createInspectorProfiler({maxPayloadBytes: 0})).toThrow('invalid_payload'); expect(() => createInspectorProfiler({maxPayloadBytes: 64 * 1024 * 1024 + 1})).toThrow('invalid_payload'); expect(() => createInspectorProfiler({clock: {} as never})).toThrow('invalid_clock') })
	it('stops serializing an oversized profile before traversing later metadata', async() => {
		let hostileReads = 0
		mocks.MockSession.payload = Object.defineProperty({nodes: Array.from({length: 100}, () => 'xxxxxxxx')}, 'authorization', {
			enumerable: true,
			get() { hostileReads++; throw new Error('secret metadata') }
		})
		await expect(createInspectorProfiler({maxPayloadBytes: 64}).capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profile_too_large')
		expect(hostileReads).toBe(0)
	})
	it('rejects excessive Inspector keys before materializing their descriptors', async() => {
		let descriptorReads = 0
		mocks.MockSession.payload = new Proxy(Object.fromEntries(
			Array.from({length: 100}, (_, index) => [`field${index}`, index])
		), {
			getOwnPropertyDescriptor(target, key) {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		await expect(createInspectorProfiler({maxPayloadBytes: 64}).capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profile_too_large')
		expect(descriptorReads).toBe(0)
	})
	it('bounds structural traversal independently from the payload byte limit', async() => {
		let descriptorReads = 0
		mocks.MockSession.payload = {nodes: new Proxy(Array.from({length: 262_145}, () => 0), {
			getOwnPropertyDescriptor(target, key) {
				descriptorReads++
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})}
		await expect(createInspectorProfiler({maxPayloadBytes: 64 * 1024 * 1024}).capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profile_too_large')
		expect(descriptorReads).toBe(0)
	})
	it('accounts for escaped and Unicode JSON bytes at the exact payload boundary', async() => {
		mocks.MockSession.payload = {nodes: ['😀', '\ud800', '\u0000', '"', '\\']}
		const bytes = Buffer.byteLength(JSON.stringify(mocks.MockSession.payload))
		await expect(createInspectorProfiler({maxPayloadBytes: bytes}).capture({type: 'cpu', durationMs: 1}))
			.resolves.toMatchObject({captured: true})
		await expect(createInspectorProfiler({maxPayloadBytes: bytes - 1}).capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profile_too_large')
	})
	it('accounts for highly escaped strings at their encoded boundary', async() => {
		mocks.MockSession.payload = {nodes: ['\u0000'.repeat(100)]}
		const bytes = Buffer.byteLength(JSON.stringify(mocks.MockSession.payload))
		await expect(createInspectorProfiler({maxPayloadBytes: bytes}).capture({type: 'cpu', durationMs: 1}))
			.resolves.toMatchObject({captured: true})
		await expect(createInspectorProfiler({maxPayloadBytes: bytes - 1}).capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profile_too_large')
	})
	it('serializes numeric profiles across bounded output chunks', async() => {
		mocks.MockSession.payload = {nodes: Array.from({length: 5_000}, () => 0)}
		const bytes = Buffer.byteLength(JSON.stringify(mocks.MockSession.payload))
		const captured = await createInspectorProfiler({maxPayloadBytes: bytes}).capture({type: 'cpu', durationMs: 1})
		expect(JSON.parse(captured.payload ?? '')).toEqual(mocks.MockSession.payload)
	})

	it('does not trust a rewired global JSON serializer for Inspector payloads', async() => {
		vi.stubGlobal('JSON', {stringify: () => '"forged"'})
		let payload: string
		try {
			payload = (await createInspectorProfiler().capture({type: 'cpu', durationMs: 1})).payload ?? ''
		} finally { vi.unstubAllGlobals() }
		expect(payload).not.toBe('"forged"')
		expect(payload).toContain('nodes')
	})
	it('does not execute Inspector toJSON hooks or nested payload accessors', async() => {
		let toJsonCalls = 0
		mocks.MockSession.payload = {nodes: [], toJSON() { toJsonCalls++; return {forged: true} }}
		const captured = await createInspectorProfiler().capture({type: 'cpu', durationMs: 1})
		expect(toJsonCalls).toBe(0)
		expect(captured.payload).toContain('nodes')
		expect(captured.payload).not.toContain('forged')

		let accessorCalls = 0
		mocks.MockSession.payload = {nodes: [Object.defineProperty({}, 'secret', {
			enumerable: true,
			get() { accessorCalls++; return 'authorization=secret' }
		})]}
		await expect(createInspectorProfiler().capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profiling_invalid_inspector_result')
		expect(accessorCalls).toBe(0)
	})
	it('does not execute an accessor-backed Inspector stop result', async() => {
		mocks.MockSession.profileAccessor = true
		await expect(createInspectorProfiler().capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profiling_invalid_inspector_result')
		expect(mocks.MockSession.profileAccessorReads).toBe(0)
	})
	it('sanitizes hostile option, capture and clock failures', async() => {
		let optionReads = 0
		expect(() => createInspectorProfiler(Object.defineProperty({}, 'clock', {
			get() { optionReads++; throw new Error('raw option secret') }
		}) as never)).toThrow('profiling_invalid_options')
		expect(optionReads).toBe(0)
		const profiler = createInspectorProfiler()
		await expect(profiler.capture(new Proxy({}, {
			getOwnPropertyDescriptor() { throw new Error('raw capture secret') }
		}) as never)).rejects.toThrow('profiling_invalid_capture_options')
		await expect(profiler.capture({
			type: 'cpu', signal: {aborted: false, get addEventListener(): never {
				throw new Error('raw signal secret')
			}} as never
		})).rejects.toThrow('profiling_invalid_capture_options')
		const brokenClock = createInspectorProfiler({clock: {
			now() { throw new Error('raw clock secret') }
		}})
		await expect(brokenClock.capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('profiling_invalid_clock')
	})
	it('rejects overlap and aborts safely', async() => {
		vi.useFakeTimers(); try { const profiler = createInspectorProfiler(); const secondProfiler = createInspectorProfiler(); const controller = new AbortController(); const first = profiler.capture({type: 'cpu', durationMs: 1_000, signal: controller.signal} as never); await vi.waitFor(() => expect(mocks.MockSession.posts).toContain('Profiler.start')); await expect(profiler.capture({type: 'cpu'})).rejects.toThrow('capture_in_progress'); await expect(secondProfiler.capture({type: 'cpu'})).rejects.toThrow('capture_in_progress'); controller.abort(new Error('authorization=secret-abort-reason')); await expect(first).rejects.toThrow(/^profile_aborted$/u); expect(mocks.MockSession.posts).toContain('Profiler.stop'); expect(mocks.MockSession.disconnects).toBe(1) } finally { vi.useRealTimers() }
	})
	it('preserves Inspector ownership across separately loaded package instances', async() => {
		vi.useFakeTimers()
		try {
			const controller = new AbortController()
			const first = createInspectorProfiler().capture({type: 'cpu', durationMs: 1_000, signal: controller.signal})
			await vi.waitFor(() => expect(mocks.MockSession.posts).toContain('Profiler.start'))

			vi.resetModules()
			const {createInspectorProfiler: createFromSecondInstance} = await import('../src/profilers-inspector')
			await expect(createFromSecondInstance().capture({type: 'cpu', durationMs: 1}))
				.rejects.toThrow('capture_in_progress')

			controller.abort(new Error('stop'))
			await expect(first).rejects.toThrow('profile_aborted')
		} finally { vi.useRealTimers() }
	})
	it('rejects standalone Inspector overlap with a managed custom CPU capture', async() => {
		vi.useFakeTimers()
		let release!: (value: {
			type: 'cpu'; format: 'cpuprofile'; name: string; startedAt: number; endedAt: number
			durationMs: number; captured: true; payload: string; resource: Record<string, string>
		}) => void
		const runtime = await createProfilingManager({
			profiler: {capture: async() => await new Promise((resolve) => { release = resolve })},
			destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
		})
		try {
			const managed = runtime.capture({type: 'cpu', durationMs: 1})
			await vi.waitFor(() => expect(release).toBeTypeOf('function'))
			const standalone = createInspectorProfiler().capture({type: 'cpu', durationMs: 1})
				.then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : 'unknown')
			await vi.advanceTimersByTimeAsync(1)
			release({type: 'cpu', format: 'cpuprofile', name: 'managed', startedAt: 1, endedAt: 2,
				durationMs: 1, captured: true, payload: '{}', resource: {}})
			await managed
			expect(await standalone).toBe('capture_in_progress')
		} finally {
			await runtime.shutdown()
			vi.useRealTimers()
		}
	})
	it('rejects standalone Inspector while continuous profiling owns CPU', async() => {
		const continuous = await createProfilingManager({continuous: {
			start: async() => undefined,
			shutdown: async() => undefined,
			getStatus: () => ({state: 'running', healthy: true})
		}})
		await expect(createInspectorProfiler().capture({type: 'cpu', durationMs: 1}))
			.rejects.toThrow('capture_in_progress')
		await continuous.shutdown()
		await expect(createInspectorProfiler({clock: {now: () => 1}}).capture({type: 'cpu', durationMs: 1}))
			.resolves.toMatchObject({captured: true})
	})
	it('rejects managed custom CPU overlap with an active standalone Inspector', async() => {
		vi.useFakeTimers()
		try {
			const controller = new AbortController()
			const standalone = createInspectorProfiler().capture({type: 'cpu', durationMs: 1_000, signal: controller.signal})
			await vi.waitFor(() => expect(mocks.MockSession.posts).toContain('Profiler.start'))
			const customCapture = vi.fn(async() => ({type: 'cpu' as const, format: 'cpuprofile' as const,
				name: 'custom', startedAt: 1, endedAt: 2, durationMs: 1, captured: true as const,
				payload: '{}', resource: {}}))
			const runtime = await createProfilingManager({
				profiler: {capture: customCapture},
				destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
			})
			await expect(runtime.capture({type: 'cpu'})).resolves.toMatchObject({
				captured: false, reason: 'capture_in_progress'
			})
			expect(customCapture).not.toHaveBeenCalled()
			controller.abort(new Error('stop'))
			await expect(standalone).rejects.toThrow('profile_aborted')
			await runtime.shutdown()
		} finally { vi.useRealTimers() }
	})
	it('allows Inspector delegated by the owning profiling manager', async() => {
		vi.useFakeTimers()
		try {
			const runtime = await createProfilingManager({
				clock: {now: () => 1},
				profiler: createInspectorProfiler({clock: {now: () => 1}}),
				destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
			})
			const capture = runtime.capture({type: 'cpu', durationMs: 1})
			await vi.waitFor(() => expect(mocks.MockSession.posts).toContain('Profiler.start'))
			await vi.advanceTimersByTimeAsync(1)
			await expect(capture).resolves.toMatchObject({captured: true})
			await runtime.shutdown()
		} finally { vi.useRealTimers() }
	})
	it('preserves managed Inspector delegation through lazy async loading', async() => {
		vi.useFakeTimers()
		try {
			const clock = {now: () => 1}
			const runtime = await createProfilingManager({
				clock,
				profiler: createLazyInspectorProfiler(clock),
				destinations: [{name: 'sink', exporter: {export: async() => undefined}}]
			})
			const capture = runtime.capture({type: 'cpu', durationMs: 1})
			await vi.waitFor(() => expect(mocks.MockSession.posts).toContain('Profiler.start'))
			await vi.advanceTimersByTimeAsync(1)
			await expect(capture).resolves.toMatchObject({captured: true})
			await runtime.shutdown()
		} finally { vi.useRealTimers() }
	})
	it('still stops the CPU profiler when abort-time disconnect fails', async() => {
		vi.useFakeTimers()
		try {
			mocks.MockSession.disconnectFails = true
			const profiler = createInspectorProfiler()
			const controller = new AbortController()
			const capture = profiler.capture({type: 'cpu', durationMs: 1_000, signal: controller.signal} as never)
			await vi.waitFor(() => expect(mocks.MockSession.posts).toContain('Profiler.start'))
			controller.abort(new Error('cancelled'))
			await expect(capture).rejects.toThrow('profile_aborted')
			expect(mocks.MockSession.posts).toContain('Profiler.stop')
			mocks.MockSession.disconnectFails = false
			const nextCapture = profiler.capture({type: 'cpu', durationMs: 1})
			await vi.advanceTimersByTimeAsync(1)
			await expect(nextCapture).resolves.toMatchObject({captured: true})
		} finally { vi.useRealTimers() }
	})
	it('retries failed stop and disconnect cleanup before admitting the next capture', async() => {
		mocks.MockSession.stopFailuresRemaining = 2
		mocks.MockSession.disconnectFailuresRemaining = 1
		const profiler = createInspectorProfiler({clock: {now: () => 1}})

		await expect(profiler.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('stop failed')
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).resolves.toMatchObject({captured: true})
		expect(mocks.MockSession.posts.filter((method) => method === 'Profiler.stop')).toHaveLength(3)
	})
	it('never duplicates a pending physical stop when abort-time disconnect fails', async() => {
		vi.useFakeTimers()
		try {
			mocks.MockSession.blockedMethod = 'Profiler.stop'
			mocks.MockSession.disconnectFails = true
			const controller = new AbortController()
			const capture = createInspectorProfiler().capture({type: 'cpu', durationMs: 1, signal: controller.signal})
			await vi.advanceTimersByTimeAsync(1)
			await vi.waitFor(() => expect(mocks.MockSession.releasePost).toBeTypeOf('function'))
			controller.abort(new Error('cancelled while stopping'))
			await vi.advanceTimersByTimeAsync(0)
			expect(mocks.MockSession.posts.filter((method) => method === 'Profiler.stop')).toHaveLength(1)

			mocks.MockSession.disconnectFails = false
			mocks.MockSession.blockedMethod = undefined
			mocks.MockSession.releasePost?.()
			await expect(capture).rejects.toThrow('profile_aborted')
		} finally { vi.useRealTimers() }
	})
	it('releases ownership when timed-out Inspector cleanup later succeeds', async() => {
		vi.useFakeTimers()
		try {
			mocks.MockSession.blockedMethod = 'Profiler.stop'
			mocks.MockSession.disconnectFails = true
			const controller = new AbortController()
			const capture = createInspectorProfiler().capture({type: 'cpu', durationMs: 1_000, signal: controller.signal})
			await vi.waitFor(() => expect(mocks.MockSession.posts).toContain('Profiler.start'))
			controller.abort(new Error('cancelled'))
			await vi.waitFor(() => expect(mocks.MockSession.releasePost).toBeTypeOf('function'))
			const failed = expect(capture).rejects.toThrow('profile_aborted')
			await vi.advanceTimersByTimeAsync(1_000)
			await failed
			await expect(createInspectorProfiler().capture({type: 'cpu', durationMs: 1})).rejects.toThrow('capture_in_progress')

			mocks.MockSession.disconnectFails = false
			mocks.MockSession.blockedMethod = undefined
			mocks.MockSession.releasePost?.()
			await vi.runAllTimersAsync()
			const next = createInspectorProfiler().capture({type: 'cpu', durationMs: 1})
			const completed = expect(next).resolves.toMatchObject({captured: true})
			await vi.advanceTimersByTimeAsync(1)
			await completed
		} finally { vi.useRealTimers() }
	})
	it('honors cancellation that arrives while Inspector is starting', async() => {
		vi.useFakeTimers()
		try {
			mocks.MockSession.blockedMethod = 'Profiler.start'
			const controller = new AbortController()
			const capture = createInspectorProfiler().capture({type: 'cpu', durationMs: 1, signal: controller.signal})
			await vi.waitFor(() => expect(mocks.MockSession.releasePost).toBeTypeOf('function'))
			const rejected = expect(capture).rejects.toThrow('profile_aborted')
			controller.abort(new Error('cancelled during startup'))
			mocks.MockSession.releasePost?.()
			await vi.advanceTimersByTimeAsync(1)
			await rejected
		} finally { vi.useRealTimers() }
	})
	it('bounds a standalone capture when Inspector startup never settles', async() => {
		vi.useFakeTimers()
		try {
			mocks.MockSession.blockedMethod = 'Profiler.start'
			const capture = createInspectorProfiler().capture({type: 'cpu', durationMs: 1})
			await vi.waitFor(() => expect(mocks.MockSession.releasePost).toBeTypeOf('function'))
			const failed = expect(capture).rejects.toThrow('profiling_capture_timeout')
			await vi.advanceTimersByTimeAsync(2_001)
			await failed
			mocks.MockSession.releasePost?.()
			mocks.MockSession.blockedMethod = undefined
			await vi.runAllTimersAsync()
			const nextCapture = createInspectorProfiler().capture({type: 'cpu', durationMs: 1})
			await vi.advanceTimersByTimeAsync(1)
			await expect(nextCapture).resolves.toMatchObject({captured: true})
		} finally { vi.useRealTimers() }
	})
	it('preserves cancellation that arrives while Inspector is stopping', async() => {
		vi.useFakeTimers()
		try {
			mocks.MockSession.blockedMethod = 'Profiler.stop'
			const controller = new AbortController()
			const capture = createInspectorProfiler().capture({type: 'cpu', durationMs: 1, signal: controller.signal})
			await vi.advanceTimersByTimeAsync(1)
			await vi.waitFor(() => expect(mocks.MockSession.releasePost).toBeTypeOf('function'))
			controller.abort(new Error('cancelled while stopping'))
			mocks.MockSession.releasePost?.()
			await expect(capture).rejects.toThrow('profile_aborted')
		} finally { vi.useRealTimers() }
	})
	it('validates standalone durations and isolates disconnect failures', async() => {
		const profiler = createInspectorProfiler({clock: {now: () => 1}})
		await expect(profiler.capture({type: 'cpu', durationMs: 0})).rejects.toThrow('invalid_duration')
		await expect(profiler.capture({type: 'cpu', durationMs: 30_001})).rejects.toThrow('invalid_duration')
		mocks.MockSession.disconnectFails = true
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).resolves.toMatchObject({captured: true})
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).resolves.toMatchObject({captured: true})
	})
	it('rejects capture accessors without executing them or leaking ownership', async() => {
		let durationReads = 0
		const input = {
			type: 'cpu' as const,
			get durationMs(): number { durationReads++; return durationReads === 1 ? 1 : 30_001 },
			signal: {
				aborted: false,
				addEventListener() {},
				removeEventListener() { throw new Error('cleanup failed') }
			}
		}
		const profiler = createInspectorProfiler({clock: {now: () => 1}})
		await expect(profiler.capture(input as never)).rejects.toThrow('invalid_capture_options')
		expect(durationReads).toBe(0)
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).resolves.toMatchObject({captured: true})
	})
	it('reserves Inspector ownership before reading caller-controlled capture fields', async() => {
		const profiler = createInspectorProfiler({clock: {now: () => 1}})
		let nested: Promise<unknown> | undefined; let reentered = false
		const input = new Proxy({type: 'cpu' as const, durationMs: 1}, {
			getOwnPropertyDescriptor(target, key) {
				if (!reentered) {
					reentered = true
					nested = profiler.capture({type: 'cpu', durationMs: 1})
					void nested.catch(() => undefined)
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		await expect(profiler.capture(input)).resolves.toMatchObject({captured: true})
		await expect(nested).rejects.toThrow('capture_in_progress')
		expect(mocks.MockSession.posts.filter((method) => method === 'Profiler.start')).toHaveLength(1)
	})
	it('retains process ownership until a cancelled pending Inspector start is fenced', async() => {
		vi.useFakeTimers()
		try {
			mocks.MockSession.blockedMethod = 'Profiler.start'
			const controller = new AbortController()
			const profiler = createInspectorProfiler()
			const capture = profiler.capture({type: 'cpu', durationMs: 1, signal: controller.signal})
			await vi.waitFor(() => expect(mocks.MockSession.releasePost).toBeTypeOf('function'))
			controller.abort(new Error('cancelled during pending start'))
			await expect(capture).rejects.toThrow('profile_aborted')
			await expect(createInspectorProfiler().capture({type: 'cpu', durationMs: 1}))
				.rejects.toThrow('capture_in_progress')

			mocks.MockSession.blockedMethod = undefined
			mocks.MockSession.releasePost?.()
			await vi.runAllTimersAsync()
			const next = createInspectorProfiler().capture({type: 'cpu', durationMs: 1})
			await vi.advanceTimersByTimeAsync(1)
			await expect(next).resolves.toMatchObject({captured: true})
		} finally { vi.useRealTimers() }
	})
	it('snapshots the validated clock method at construction', async() => {
		const clock = {now: () => 7}
		const profiler = createInspectorProfiler({clock})
		clock.now = () => { throw new Error('mutated clock') }
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).resolves.toMatchObject({
			startedAt: 7, endedAt: 7
		})
	})
	it('clamps duration when the injected clock moves backward', async() => {
		let now = 10
		const profiler = createInspectorProfiler({clock: {now: () => now--}})
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).resolves.toMatchObject({
			startedAt: 10, endedAt: 10, durationMs: 0
		})
	})
	it('does not leak process ownership when capture setup fails synchronously', async() => {
		const broken = createInspectorProfiler({clock: {now() { throw new Error('clock failed') }}})
		await expect(broken.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('profiling_invalid_clock')
		await expect(createInspectorProfiler({clock: {now: () => 1}}).capture({type: 'cpu', durationMs: 1}))
			.resolves.toMatchObject({captured: true})
	})
	it('rejects non-finite clock results without retaining process ownership', async() => {
		const invalid = createInspectorProfiler({clock: {now: () => Number.NaN}})
		await expect(invalid.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('invalid_clock')
		await expect(createInspectorProfiler({clock: {now: () => 1}}).capture({type: 'cpu', durationMs: 1}))
			.resolves.toMatchObject({captured: true})
	})
	it('observes a rejected asynchronous clock result without retaining ownership', async() => {
		let rejectionObserved = false
		const invalid = createInspectorProfiler({clock: {now: (() => ({
			then(_resolve: () => void, reject: (reason: Error) => void) {
				rejectionObserved = true
				reject(new Error('authorization=secret-async-clock'))
			}
		})) as never}})
		await expect(invalid.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('invalid_clock')
		await vi.waitFor(() => expect(rejectionObserved).toBe(true))
		await expect(createInspectorProfiler({clock: {now: () => 1}}).capture({type: 'cpu', durationMs: 1}))
			.resolves.toMatchObject({captured: true})
	})
	it('rejects negative and fractional epoch clocks without retaining process ownership', async() => {
		for (const value of [-1, 1.5]) {
			const invalid = createInspectorProfiler({clock: {now: () => value}})
			await expect(invalid.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('invalid_clock')
		}
		await expect(createInspectorProfiler({clock: {now: () => 1}}).capture({type: 'cpu', durationMs: 1}))
			.resolves.toMatchObject({captured: true})
	})
	it('rejects pre-aborted requests and invalid inspector payloads safely', async() => {
		const profiler = createInspectorProfiler()
		let prototypeReads = 0
		const reason = new Proxy({}, {getPrototypeOf() { prototypeReads++; throw new Error('secret abort reason') }})
		const controller = new AbortController(); controller.abort(reason)
		await expect(profiler.capture({type: 'cpu', signal: controller.signal} as never)).rejects.toThrow('profile_aborted')
		expect(prototypeReads).toBe(0)
		mocks.MockSession.payload = undefined
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('invalid_inspector_result')
		mocks.MockSession.payload = null
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('invalid_inspector_result')
		mocks.MockSession.payload = []
		await expect(profiler.capture({type: 'cpu', durationMs: 1})).rejects.toThrow('invalid_inspector_result')
	})
})
