import {describe, expect, it, vi} from 'vitest'

import {createProfilingManager} from '../src/manager'
import {createPyroscopeProfilingWithSdk} from '../src/pyroscope-provider'

const options = {
	applicationName: 'ooops-suite-worker',
	connection: {mode: 'grafana-cloud' as const, serverAddress: 'https://profiles.example.test/ingest', credentials: {username: '12345', password: 'token-secret'}},
	resource: {serviceName: 'suite', serviceVersion: '1.2.3', deploymentEnvironment: 'production'}
}

describe('Pyroscope continuous provider', () => {
	it('is lazy, captures methods once, and exposes frozen sanitized status', async() => {
		const init = vi.fn(); const startCpuProfiling = vi.fn(); const stopCpuProfiling = vi.fn()
		const loader = vi.fn(async() => ({default: {init, startCpuProfiling, stopCpuProfiling}}))
		const provider = createPyroscopeProfilingWithSdk(options, loader)
		expect(loader).not.toHaveBeenCalled(); expect(Object.isFrozen(provider.getStatus())).toBe(true)
		await provider.start(); expect(init).toHaveBeenCalledWith(expect.objectContaining({basicAuthUser: '12345', basicAuthPassword: 'token-secret'}))
		expect(provider.getStatus()).toEqual({state: 'running', healthy: true})
		await Promise.all([provider.shutdown(), provider.shutdown()]); expect(stopCpuProfiling).toHaveBeenCalledOnce()
		expect(provider.getStatus()).toEqual({state: 'closed', healthy: false})
	})

	it('installs start single-flight before invoking a re-entrant SDK loader', async() => {
		const init = vi.fn(); const startCpuProfiling = vi.fn(); const stopCpuProfiling = vi.fn()
		let provider!: ReturnType<typeof createPyroscopeProfilingWithSdk>
		let nested: Promise<void> | undefined; let loads = 0
		provider = createPyroscopeProfilingWithSdk(options, async() => {
			loads++
			if (!nested) nested = provider.start()
			return {default: {init, startCpuProfiling, stopCpuProfiling}}
		})

		await provider.start()
		await nested
		expect(loads).toBe(1)
		expect(init).toHaveBeenCalledOnce()
		expect(startCpuProfiling).toHaveBeenCalledOnce()
		await provider.shutdown()
	})

	it('rejects dynamic SDK method accessors without executing them', async() => {
		let reads = 0
		const runtime = {
			get init() { reads++; return vi.fn() },
			get startCpuProfiling() { reads++; return vi.fn() },
			get stopCpuProfiling() { reads++; return vi.fn() }
		}
		const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: runtime}))
		await expect(provider.start()).rejects.toThrow('PYROSCOPE_START_FAILURE')
		expect(reads).toBe(0)
		await provider.shutdown()
	})

	it('enforces cloud TLS and credential-free URLs', () => {
		expect(() => createPyroscopeProfilingWithSdk({...options, connection: {...options.connection, serverAddress: 'http://profiles.test'}}, vi.fn())).toThrow('requires_https')
		expect(() => createPyroscopeProfilingWithSdk({...options, connection: {...options.connection, serverAddress: 'https://user:pass@profiles.test'}}, vi.fn())).toThrow('embedded_credentials')
		expect(() => createPyroscopeProfilingWithSdk({...options, connection: {
			mode: 'self-hosted',
			serverAddress: 'http://pyroscope.internal:4040',
			credentials: {username: 'tenant', password: 'secret'}
		}}, vi.fn())).toThrow('credentials_require_https')
		expect(() => createPyroscopeProfilingWithSdk({...options, connection: {
			mode: 'alloy', serverAddress: 'https://alloy.example.test',
			credentials: {username: 'tenant', password: 'must-not-leak'}
		} as never}, vi.fn())).toThrow('credentials_forbidden')
		expect(() => createPyroscopeProfilingWithSdk({...options, connection: {
			...options.connection, tenantId: 'cross-mode-tenant'
		} as never}, vi.fn())).toThrow('tenant_forbidden')
	})

	it('does not trust a rewired global URL constructor for credential transport validation', () => {
		vi.stubGlobal('URL', class {
			username = ''; password = ''; search = ''; hash = ''
			protocol = 'https:'; href = 'http://attacker.example/'
		})
		try {
			expect(() => createPyroscopeProfilingWithSdk({...options, connection: {
				...options.connection, serverAddress: 'http://attacker.example/'
			}}, vi.fn())).toThrow('pyroscope_cloud_requires_https')
		} finally { vi.unstubAllGlobals() }
	})

	it('rejects overlong server addresses before URL parsing', () => {
		const OriginalURL = URL
		const urlConstructor = vi.fn()
		vi.stubGlobal('URL', class {
			constructor(...args: unknown[]) { urlConstructor(...args); return new OriginalURL(...args as [string]) }
		})
		try {
			expect(() => createPyroscopeProfilingWithSdk({...options, connection: {
				...options.connection,
				serverAddress: `https://profiles.example.test/${'x'.repeat(2_049)}`
			}}, vi.fn())).toThrow('pyroscope_invalid_server_address')
			expect(urlConstructor).not.toHaveBeenCalled()
		} finally { vi.unstubAllGlobals() }
	})

	it('rejects accessors without executing them', () => {
		let reads = 0
		const hostile = Object.defineProperty({}, 'connection', {enumerable: true, get() { reads++; return options.connection }})
		expect(() => createPyroscopeProfilingWithSdk(hostile as never, vi.fn())).toThrow('invalid_options')
		expect(reads).toBe(0)
	})

	it('reads only the fixed Pyroscope tag schema without enumerating metadata', async() => {
		let enumerations = 0
		const tags = new Proxy({team: 'platform'}, {
			ownKeys() { enumerations++; throw new Error('unbounded tag enumeration') }
		})
		const init = vi.fn()
		const provider = createPyroscopeProfilingWithSdk({...options, tags}, async() => ({default: {
			init, startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
		}}))
		await provider.start()
		expect(enumerations).toBe(0)
		expect(init).toHaveBeenCalledWith(expect.objectContaining({tags: expect.objectContaining({team: 'platform'})}))
		await provider.shutdown()
	})

	it('sanitizes sensitive resource and configured tags before SDK initialization', async() => {
		const init = vi.fn()
		const provider = createPyroscopeProfilingWithSdk({
			...options,
			resource: {...options.resource, hostKind: '192.0.2.44'},
			tags: {
				build: '0123456789abcdef0123456789abcdef',
				region: 'https://region.example/abcdef0123456789abcdef0123456789'
			}
		}, async() => ({default: {
			init, startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
		}}))

		await provider.start()
		expect(init).toHaveBeenCalledWith(expect.objectContaining({
			tags: expect.objectContaining({host_kind: 'redacted', build: 'redacted', region: 'redacted'})
		}))
		await provider.shutdown()
	})

	it('redacts JWT values from otherwise valid Pyroscope tags', async() => {
		const init = vi.fn()
		const provider = createPyroscopeProfilingWithSdk({...options, tags: {
			team: 'aaaaaaaa.bbbbbbbb.cccccccc'
		}}, async() => ({default: {init, startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()}}))
		await provider.start()
		expect(init).toHaveBeenCalledWith(expect.objectContaining({tags: expect.objectContaining({team: 'redacted'})}))
		await provider.shutdown()
	})

	it('redacts AWS access-key IDs from Pyroscope tags', async() => {
		const init = vi.fn()
		const provider = createPyroscopeProfilingWithSdk({...options, tags: {
			team: 'build-AKIAIOSFODNN7EXAMPLE'
		}}, async() => ({default: {init, startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()}}))
		await provider.start()
		expect(init).toHaveBeenCalledWith(expect.objectContaining({tags: expect.objectContaining({team: 'redacted'})}))
		await provider.shutdown()
	})

	it('rejects SDK environment overrides before initialization', async() => {
		const init = vi.fn()
		const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init, startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
		}}))
		try {
			vi.stubEnv('PYROSCOPE_AUTH_TOKEN', 'environment-secret')
			await expect(provider.start()).rejects.toThrow('PYROSCOPE_START_FAILURE')
			expect(init).not.toHaveBeenCalled()
		} finally { vi.unstubAllEnvs() }
	})

	it('rejects SDK environment overrides introduced during async initialization', async() => {
		const startCpuProfiling = vi.fn()
		const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init: vi.fn(async() => { vi.stubEnv('PYROSCOPE_SERVER_ADDRESS', 'https://redirected.example.test') }),
			startCpuProfiling,
			stopCpuProfiling: vi.fn()
		}}))
		try {
			await expect(provider.start()).rejects.toThrow('PYROSCOPE_START_FAILURE')
			expect(startCpuProfiling).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllEnvs()
			await provider.shutdown()
		}
	})

	it('enforces one process owner', async() => {
		const sdk = () => ({default: {init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()}})
		const first = createPyroscopeProfilingWithSdk(options, async() => sdk())
		const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'second'}, async() => sdk())
		await first.start(); await expect(second.start()).rejects.toThrow('already_active'); await first.shutdown()
		await second.start(); await second.shutdown()
	})

	it('enforces process ownership across separately loaded package instances', async() => {
		const first = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
		}}))
		await first.start()

		vi.resetModules()
		const {createPyroscopeProfilingWithSdk: createFromSecondInstance} = await import('../src/pyroscope-provider')
		const secondStart = vi.fn()
		const second = createFromSecondInstance({...options, applicationName: 'second-module-instance'}, async() => ({default: {
			init: vi.fn(), startCpuProfiling: secondStart, stopCpuProfiling: vi.fn()
		}}))

		await expect(second.start()).rejects.toThrow('pyroscope_already_active')
		expect(secondStart).not.toHaveBeenCalled()
		await first.shutdown()
		await second.start()
		await second.shutdown()
	})

	it('coordinates standalone Pyroscope with managed continuous ownership', async() => {
		let customState: 'idle' | 'running' | 'closed' = 'idle'
		const managed = await createProfilingManager({continuous: {
			start: async() => { customState = 'running' },
			shutdown: async() => { customState = 'closed' },
			getStatus: () => ({state: customState, healthy: customState === 'running'})
		}})
		const standaloneStart = vi.fn()
		const standalone = createPyroscopeProfilingWithSdk({...options, applicationName: 'standalone-fenced'}, async() => ({default: {
			init: vi.fn(), startCpuProfiling: standaloneStart, stopCpuProfiling: vi.fn()
		}}))

		await expect(standalone.start()).rejects.toThrow('pyroscope_already_active')
		expect(standaloneStart).not.toHaveBeenCalled()
		await managed.shutdown()
		await standalone.start()
		await expect(createProfilingManager({continuous: {
			start: vi.fn(async() => undefined), shutdown: vi.fn(async() => undefined),
			getStatus: () => ({state: 'running', healthy: true})
		}})).rejects.toThrow('profiling_continuous_in_progress')
		await standalone.shutdown()
	})

	it('rejects standalone Pyroscope while a manual CPU capture owns the process', async() => {
		let release!: (value: {
			type: 'cpu'; format: 'cpuprofile'; name: string; startedAt: number; endedAt: number
			durationMs: number; captured: true; payload: string; resource: Record<string, string>
		}) => void
		const manual = await createProfilingManager({
			profiler: {capture: async() => await new Promise((resolve) => { release = resolve })}
		})
		const capture = manual.capture({type: 'cpu'})
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		const startCpuProfiling = vi.fn()
		const provider = createPyroscopeProfilingWithSdk({...options, applicationName: 'manual-fenced'}, async() => ({default: {
			init: vi.fn(), startCpuProfiling, stopCpuProfiling: vi.fn()
		}}))

		await expect(provider.start()).rejects.toThrow('pyroscope_already_active')
		expect(startCpuProfiling).not.toHaveBeenCalled()
		release({type: 'cpu', format: 'cpuprofile', name: 'manual', startedAt: 1, endedAt: 2,
			durationMs: 1, captured: true, payload: '{}', resource: {}})
		await capture
		await provider.start()
		await provider.shutdown()
		await manual.shutdown()
	})

	it('allows Pyroscope delegated by the owning profiling manager', async() => {
		const startCpuProfiling = vi.fn(); const stopCpuProfiling = vi.fn()
		const provider = createPyroscopeProfilingWithSdk({...options, applicationName: 'managed-pyroscope'}, async() => ({default: {
			init: vi.fn(), startCpuProfiling, stopCpuProfiling
		}}))
		const managed = await createProfilingManager({continuous: provider})
		expect(startCpuProfiling).toHaveBeenCalledOnce()
		await managed.shutdown()
		expect(stopCpuProfiling).toHaveBeenCalledOnce()
	})

	it('cleans up an ambiguous SDK start failure before releasing process ownership', async() => {
		let physicallyActive = false
		const stopCpuProfiling = vi.fn(async() => { physicallyActive = false })
		const first = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init: vi.fn(),
			startCpuProfiling: vi.fn(async() => {
				physicallyActive = true
				throw new Error('ambiguous start failure')
			}),
			stopCpuProfiling
		}}))

		await expect(first.start()).rejects.toThrow('PYROSCOPE_START_FAILURE')
		expect(stopCpuProfiling).toHaveBeenCalledOnce()
		expect(physicallyActive).toBe(false)

		const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'after-failure'}, async() => ({default: {
			init: vi.fn(),
			startCpuProfiling: vi.fn(async() => {
				if (physicallyActive) throw new Error('overlapping physical profiler')
				physicallyActive = true
			}),
			stopCpuProfiling: vi.fn(async() => { physicallyActive = false })
		}}))
		await expect(second.start()).resolves.toBeUndefined()
		await second.shutdown()
	})

	it('retains process ownership until failed start cleanup is retried successfully', async() => {
		let startAttempts = 0; let stopAttempts = 0
		const first = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init: vi.fn(),
			startCpuProfiling: vi.fn(async() => { if (++startAttempts === 1) throw new Error('ambiguous start failure') }),
			stopCpuProfiling: vi.fn(async() => {
				stopAttempts++
				if (stopAttempts === 1) throw new Error('cleanup failed')
			})
		}}))
		const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'fenced'}, async() => ({default: {
			init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
		}}))

		await expect(first.start()).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
		expect(first.getStatus()).toMatchObject({state: 'draining', healthy: false})
		await expect(second.start()).rejects.toThrow('pyroscope_already_active')

		await expect(first.shutdown()).resolves.toBeUndefined()
		expect(startAttempts).toBe(2)
		expect(stopAttempts).toBe(2)
		await expect(second.start()).resolves.toBeUndefined()
		await second.shutdown()
	})

	it('does not inspect hostile SDK stop rejection prototypes', async() => {
		let prototypeReads = 0; let attempts = 0
		const rejection = new Proxy({}, {
			getPrototypeOf() { prototypeReads++; throw new Error('authorization=secret-sdk-rejection') }
		})
		const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init: vi.fn(),
			startCpuProfiling: vi.fn(),
			stopCpuProfiling: vi.fn(async() => { if (++attempts === 1) await Promise.reject(rejection) })
		}}))
		await provider.start()
		await expect(provider.shutdown()).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
		expect(prototypeReads).toBe(0)
		await expect(provider.shutdown()).resolves.toBeUndefined()
	})

	it('uses a fresh SDK generation after a persistent ambiguous stop rejection', async() => {
		let generation = 0; let sdkRunning = false; let physicallyActive = false
		const init = vi.fn(async() => { generation++; sdkRunning = false })
		const startCpuProfiling = vi.fn(async() => {
			if (!sdkRunning) { sdkRunning = true; physicallyActive = true }
		})
		const stopCpuProfiling = vi.fn(async() => {
			if (!sdkRunning) return
			sdkRunning = false
			if (generation === 1) throw new Error('persistent rejected lastExport before physical stop')
			physicallyActive = false
		})
		const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init, startCpuProfiling, stopCpuProfiling
		}}))
		await provider.start()
		await expect(provider.shutdown()).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
		expect(physicallyActive).toBe(true)

		await expect(provider.shutdown()).resolves.toBeUndefined()
		expect(init).toHaveBeenCalledTimes(2)
		expect(init).toHaveBeenNthCalledWith(2, expect.objectContaining({serverAddress: 'unsupported:'}))
		expect(startCpuProfiling).toHaveBeenCalledTimes(2)
		expect(stopCpuProfiling).toHaveBeenCalledTimes(2)
		expect(physicallyActive).toBe(false)
		expect(provider.getStatus().state).toBe('closed')
	})

	it('uses an isolated recovery generation when SDK stop hangs before physical stop', async() => {
		vi.useFakeTimers()
		try {
			let releaseOriginal!: () => void
			let sdkRunning = false; let physicallyActive = false; let stopAttempts = 0
			const init = vi.fn(async() => { sdkRunning = false })
			const startCpuProfiling = vi.fn(async() => { if (!sdkRunning) { sdkRunning = true; physicallyActive = true } })
			const stopCpuProfiling = vi.fn(async() => {
				if (!sdkRunning) return
				sdkRunning = false
				if (++stopAttempts === 1) await new Promise<void>((resolve) => { releaseOriginal = resolve })
				physicallyActive = false
			})
			const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init, startCpuProfiling, stopCpuProfiling
			}}))
			await provider.start()
			const shutdown = provider.shutdown()
			const failed = expect(shutdown).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await failed
			await vi.advanceTimersByTimeAsync(0)

			expect(init).toHaveBeenCalledTimes(2)
			expect(init).toHaveBeenNthCalledWith(2, expect.objectContaining({
				serverAddress: 'unsupported:',
				basicAuthUser: undefined,
				basicAuthPassword: undefined
			}))
			expect(startCpuProfiling).toHaveBeenCalledTimes(2)
			expect(stopCpuProfiling).toHaveBeenCalledTimes(2)
			expect(physicallyActive).toBe(false)
			expect(provider.getStatus().state).toBe('draining')
			releaseOriginal()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(provider.getStatus().state).toBe('closed'))
		} finally { vi.useRealTimers() }
	})

	it('retains process ownership while isolated recovery is still in flight', async() => {
		vi.useFakeTimers()
		try {
			let releaseOriginal!: () => void; let releaseRecovery!: () => void
			let initAttempts = 0; let sdkRunning = false; let stopAttempts = 0
			const first = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(async() => {
					sdkRunning = false
					if (++initAttempts === 2) await new Promise<void>((resolve) => { releaseRecovery = resolve })
				}),
				startCpuProfiling: vi.fn(async() => { sdkRunning = true }),
				stopCpuProfiling: vi.fn(async() => {
					if (!sdkRunning) return
					sdkRunning = false
					if (++stopAttempts === 1) await new Promise<void>((resolve) => { releaseOriginal = resolve })
				})
			}}))
			const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'recovery-fenced'}, async() => ({default: {
				init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
			}}))

			await first.start()
			const shutdown = first.shutdown()
			const failed = expect(shutdown).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await failed
			await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf('function'))
			await expect(second.start()).rejects.toThrow('pyroscope_already_active')

			releaseRecovery()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(first.getStatus().state).toBe('draining'))
			await expect(second.start()).rejects.toThrow('pyroscope_already_active')
			releaseOriginal()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(first.getStatus().state).toBe('closed'))
			await second.start()
			await second.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('supersedes a hung isolated recovery on a later bounded shutdown', async() => {
		vi.useFakeTimers()
		try {
			const releases: Array<() => void> = []
			let sdkRunning = false; let stopAttempts = 0
			const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(async() => { sdkRunning = false }),
				startCpuProfiling: vi.fn(async() => { sdkRunning = true }),
				stopCpuProfiling: vi.fn(async() => {
					if (!sdkRunning) return
					sdkRunning = false
					if (++stopAttempts < 3) await new Promise<void>((resolve) => { releases.push(resolve) })
				})
			}}))
			await provider.start()

			const firstShutdown = provider.shutdown()
			const firstFailure = expect(firstShutdown).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await firstFailure
			await vi.waitFor(() => expect(stopAttempts).toBe(2))

			const secondShutdown = provider.shutdown()
			const secondFailure = expect(secondShutdown).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await secondFailure
			await vi.waitFor(() => expect(stopAttempts).toBe(3))
			await vi.waitFor(() => expect(provider.getStatus().state).toBe('draining'))
			for (const release of releases) release()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(provider.getStatus()).toEqual({state: 'closed', healthy: false}))
			await expect(provider.shutdown()).resolves.toBeUndefined()
		} finally { vi.useRealTimers() }
	})

	it('cannot become running after the public start timeout has already won', async() => {
		vi.useFakeTimers()
		try {
			let releaseStart!: () => void
			const stopCpuProfiling = vi.fn()
			const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(),
				startCpuProfiling: vi.fn(async() => await new Promise<void>((resolve) => { releaseStart = resolve })),
				stopCpuProfiling
			}}))
			const start = provider.start()
			const failedStart = expect(start).rejects.toThrow('pyroscope_start_timeout')
			await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'))

			vi.advanceTimersByTime(30_000)
			releaseStart()

			await failedStart
			await vi.runAllTimersAsync()
			expect(stopCpuProfiling).toHaveBeenCalledTimes(2)
			expect(provider.getStatus().state).toBe('idle')
		} finally { vi.useRealTimers() }
	})

	it('stops a physically active CPU profiler immediately when SDK start hangs', async() => {
		vi.useFakeTimers()
		try {
			let releaseStart!: () => void
			let physicallyActive = false
			const stopCpuProfiling = vi.fn(async() => { physicallyActive = false })
			const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(),
				startCpuProfiling: vi.fn(async() => {
					physicallyActive = true
					await new Promise<void>((resolve) => { releaseStart = resolve })
				}),
				stopCpuProfiling
			}}))
			const start = provider.start()
			const failed = expect(start).rejects.toThrow('pyroscope_start_timeout')
			await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'))
			await vi.advanceTimersByTimeAsync(30_000)
			await failed
			expect(stopCpuProfiling).toHaveBeenCalledOnce()
			expect(physicallyActive).toBe(false)

			releaseStart()
			await vi.runAllTimersAsync()
			expect(stopCpuProfiling).toHaveBeenCalledTimes(2)
			expect(provider.getStatus().state).toBe('idle')
			await provider.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('retains ownership until a superseded async start side effect settles', async() => {
		vi.useFakeTimers()
		try {
			let releaseOriginalStart!: () => void
			let startAttempts = 0; let physicallyActive = false
			const first = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(),
				startCpuProfiling: vi.fn(async() => {
					if (++startAttempts === 1) await new Promise<void>((resolve) => { releaseOriginalStart = resolve })
					physicallyActive = true
				}),
				stopCpuProfiling: vi.fn(async() => { physicallyActive = false })
			}}))
			const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'after-late-start'}, async() => ({default: {
				init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
			}}))

			const start = first.start()
			const startFailure = expect(start).rejects.toThrow('pyroscope_start_timeout')
			await vi.waitFor(() => expect(releaseOriginalStart).toBeTypeOf('function'))
			await vi.advanceTimersByTimeAsync(30_000)
			await startFailure
			const shutdown = first.shutdown()
			const shutdownFailure = expect(shutdown).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await shutdownFailure
			await vi.waitFor(() => expect(first.getStatus().state).toBe('draining'))
			await expect(second.start()).rejects.toThrow('pyroscope_already_active')

			releaseOriginalStart()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(physicallyActive).toBe(false))
			await vi.waitFor(() => expect(first.getStatus().state).toBe('closed'))
			await second.start()
			await second.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('retains ownership when cleanup of a superseded late start fails', async() => {
		vi.useFakeTimers()
		try {
			let releaseOriginalStart!: () => void
			let startAttempts = 0; let stopAttempts = 0; let physicallyActive = false
			const first = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(),
				startCpuProfiling: vi.fn(async() => {
					if (++startAttempts === 1) await new Promise<void>((resolve) => { releaseOriginalStart = resolve })
					physicallyActive = true
				}),
				stopCpuProfiling: vi.fn(async() => {
					if (++stopAttempts === 4) throw new Error('ambiguous late cleanup')
					physicallyActive = false
				})
			}}))
			const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'after-failed-late-start'}, async() => ({default: {
				init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
			}}))

			const start = first.start()
			const startFailure = expect(start).rejects.toThrow('pyroscope_start_timeout')
			await vi.waitFor(() => expect(releaseOriginalStart).toBeTypeOf('function'))
			await vi.advanceTimersByTimeAsync(30_000)
			await startFailure
			const shutdown = first.shutdown()
			const shutdownFailure = expect(shutdown).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await shutdownFailure

			releaseOriginalStart()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(stopAttempts).toBe(4))
			expect(physicallyActive).toBe(true)
			expect(first.getStatus().state).toBe('draining')
			await expect(second.start()).rejects.toThrow('pyroscope_already_active')

			const recovery = first.shutdown()
			const recoveryTimeout = expect(recovery).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await recoveryTimeout
			await vi.waitFor(() => expect(first.getStatus().state).toBe('closed'))
			expect(physicallyActive).toBe(false)
			await second.start()
			await second.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('stops an in-flight physical start immediately when shutdown is requested', async() => {
		let releaseStart!: () => void
		let physicallyActive = false
		const stopCpuProfiling = vi.fn(async() => { physicallyActive = false })
		const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init: vi.fn(),
			startCpuProfiling: vi.fn(async() => {
				physicallyActive = true
				await new Promise<void>((resolve) => { releaseStart = resolve })
			}),
			stopCpuProfiling
		}}))
		const start = provider.start()
		await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'))
		const shutdown = provider.shutdown()
		await vi.waitFor(() => expect(stopCpuProfiling).toHaveBeenCalledOnce())
		expect(physicallyActive).toBe(false)
		expect(provider.getStatus().state).toBe('draining')

		releaseStart()
		await expect(start).rejects.toThrow('PYROSCOPE_START_FAILURE')
		await expect(shutdown).resolves.toBeUndefined()
		expect(stopCpuProfiling).toHaveBeenCalledTimes(2)
		expect(provider.getStatus().state).toBe('closed')
	})

	it('never starts CPU profiling when SDK initialization completes after timeout', async() => {
		vi.useFakeTimers()
		try {
			let releaseInit!: () => void
			const startCpuProfiling = vi.fn()
			const provider = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(async() => await new Promise<void>((resolve) => { releaseInit = resolve })),
				startCpuProfiling,
				stopCpuProfiling: vi.fn()
			}}))
			const start = provider.start()
			const failedStart = expect(start).rejects.toThrow('pyroscope_start_timeout')
			await vi.waitFor(() => expect(releaseInit).toBeTypeOf('function'))
			await vi.advanceTimersByTimeAsync(30_000)
			await failedStart

			releaseInit()
			await vi.runAllTimersAsync()
			expect(startCpuProfiling).not.toHaveBeenCalled()
			expect(provider.getStatus().state).toBe('idle')
		} finally { vi.useRealTimers() }
	})

	it('does not expose raw SDK failures through start or shutdown', async() => {
		const failedStart = createPyroscopeProfilingWithSdk(options, async() => {
			throw new Error('authorization=secret-start')
		})
		await expect(failedStart.start()).rejects.toThrow('PYROSCOPE_START_FAILURE')
		await expect(failedStart.start()).rejects.not.toThrow('secret-start')

		let stopAttempts = 0
		const failedStop = createPyroscopeProfilingWithSdk(options, async() => ({default: {
			init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn(async() => {
				stopAttempts++
				if (stopAttempts === 1) throw new Error('authorization=secret-stop')
			})
		}}))
		await failedStop.start()
		await expect(failedStop.shutdown()).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
		await expect(failedStop.shutdown()).resolves.toBeUndefined()
	})

	it('releases process ownership only after recovery and superseded stop both settle', async() => {
		vi.useFakeTimers()
		try {
			const releases: Array<() => void> = []
			const first = createPyroscopeProfilingWithSdk(options, async() => ({default: {
				init: vi.fn(), startCpuProfiling: vi.fn(),
				stopCpuProfiling: vi.fn(async() => await new Promise<void>((resolve) => { releases.push(resolve) }))
			}}))
			const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'after-late-stop'}, async() => ({default: {
				init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
			}}))
			await first.start()
			const shutdown = first.shutdown()
			const failed = expect(shutdown).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.waitFor(() => expect(releases).toHaveLength(1))
			await vi.advanceTimersByTimeAsync(30_000)
			await failed
			await vi.waitFor(() => expect(releases).toHaveLength(2))
			await expect(second.start()).rejects.toThrow('pyroscope_already_active')

			releases[1]?.()
			await vi.advanceTimersByTimeAsync(0)
			expect(first.getStatus().state).toBe('draining')
			await expect(second.start()).rejects.toThrow('pyroscope_already_active')
			const retry = first.shutdown()
			const retryFailure = expect(retry).rejects.toThrow('PYROSCOPE_SHUTDOWN_FAILURE')
			await vi.advanceTimersByTimeAsync(30_000)
			await retryFailure
			expect(releases).toHaveLength(2)
			releases[0]?.()
			await vi.advanceTimersByTimeAsync(0)
			await vi.waitFor(() => expect(first.getStatus()).toEqual({state: 'closed', healthy: false}))
			await second.start()
			await second.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('abandons a timed-out pre-start loader safely during shutdown', async() => {
		vi.useFakeTimers()
		try {
			const first = createPyroscopeProfilingWithSdk(options, async() => await new Promise<never>(() => undefined))
			const start = first.start()
			const failedStart = expect(start).rejects.toThrow('pyroscope_start_timeout')
			await vi.advanceTimersByTimeAsync(30_000)
			await failedStart
			const second = createPyroscopeProfilingWithSdk({...options, applicationName: 'after-abandon'}, async() => ({default: {
				init: vi.fn(), startCpuProfiling: vi.fn(), stopCpuProfiling: vi.fn()
			}}))
			await second.start()
			await second.shutdown()

			const shutdown = first.shutdown()
			await expect(shutdown).resolves.toBeUndefined()
		} finally { vi.useRealTimers() }
	})

	it('keeps closed terminal when a pre-SDK start times out after immediate shutdown', async() => {
		vi.useFakeTimers()
		try {
			const provider = createPyroscopeProfilingWithSdk(options, async() => await new Promise<never>(() => undefined))
			const start = provider.start()
			const failedStart = expect(start).rejects.toThrow('pyroscope_start_timeout')
			await expect(provider.shutdown()).resolves.toBeUndefined()
			expect(provider.getStatus()).toEqual({state: 'closed', healthy: false})

			await vi.advanceTimersByTimeAsync(30_000)
			await failedStart
			expect(provider.getStatus()).toEqual({state: 'closed', healthy: false})
		} finally { vi.useRealTimers() }
	})
})
