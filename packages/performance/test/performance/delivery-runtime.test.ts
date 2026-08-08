import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createEventExportManager} from '../../src/performance/core/event-export-manager'
import {
	MAX_PERFORMANCE_EXPORT_BATCH_BYTES,
	serializePerformanceEventRecord
} from '../../src/performance/core/event-export-utils'
import {createPerformanceExportError} from '../../src/performance/core/export-errors'
import {createCustomPerformance} from '../../src/performance/public/custom'
import {createHttpNdjsonPerformanceEventExporter} from '../../src/performance/public/custom-exporters-http'

describe('performance logical delivery', () => {
	it('rejects oversized strings before scanning their UTF-8 bytes', () => {
		const oversized = 'x'.repeat(MAX_PERFORMANCE_EXPORT_BATCH_BYTES + 1)
		const byteLength = vi.spyOn(Buffer, 'byteLength')
		try {
			expect(serializePerformanceEventRecord({
				recordedAt: 1,
				source: 'mark',
				event: {name: oversized, duration: 1, start: 0, end: 1, source: 'mark'}
			})).toBeNull()
			expect(byteLength).not.toHaveBeenCalledWith(oversized, 'utf8')
		} finally {
			byteLength.mockRestore()
		}
	})

	it('does not execute inherited array serialization hooks', () => {
		const inheritedToJSON = vi.fn(() => ({leaked: true}))
		const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
		Object.defineProperty(Array.prototype, 'toJSON', {
			configurable: true,
			value: inheritedToJSON
		})
		try {
			const snapshot = serializePerformanceEventRecord({
				recordedAt: 1,
				source: 'mark',
				event: {
					name: 'db.query', duration: 1, start: 0, end: 1, source: 'mark',
					dbMetadata: {orderBy: ['createdAt']} as never
				}
			})
			expect(snapshot).not.toBeNull()
			expect(inheritedToJSON).not.toHaveBeenCalled()
			expect(snapshot?.serialized).toContain('createdAt')
		} finally {
			if (previous) Object.defineProperty(Array.prototype, 'toJSON', previous)
			else delete (Array.prototype as {toJSON?: unknown}).toJSON
		}
	})

	it('bounds exporter configuration before array iteration or property enumeration', async() => {
		const oversized: Array<{name: string; exporter: {export(): Promise<void>}}> = []
		oversized.length = 100_000_000
		Object.defineProperty(oversized, 'map', {value: () => { throw new Error('must not execute') }})
		expect(() => createEventExportManager({
			exporters: oversized,
			maxBufferCount: 1,
			maxBufferBytes: 1_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0
		})).toThrow('at most two')

		const exporter = {async export() {}}
		const ownKeys = vi.fn(() => { throw new Error('must not enumerate') })
		const configured = new Proxy({name: 'safe', exporter}, {
			ownKeys
		})
		expect(() => createEventExportManager({
			exporters: [configured],
			maxBufferCount: 1,
			maxBufferBytes: 1_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0
		})).toThrow('valid objects')
		expect(ownKeys).not.toHaveBeenCalled()

		const coerceName = vi.fn(() => 'hostile')
		expect(() => createEventExportManager({
			exporters: [{name: {toString: coerceName} as never, exporter}],
			maxBufferCount: 1,
			maxBufferBytes: 1_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0
		})).toThrow('safe identifiers')
		expect(coerceName).not.toHaveBeenCalled()
	})

	it('rejects a provably saturated queue before serializing the dropped record', async() => {
		const observations: Array<{name: string; labels?: Record<string, string>}> = []
		const manager = createEventExportManager({
			exporters: [{name: 'blocked', exporter: {async export() { await new Promise(() => {}) }}}],
			maxBufferCount: 1,
			maxBufferBytes: 10_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0,
			observe: (name, _value, labels) => observations.push({name, ...(labels ? {labels} : {})})
		})
		const record = {
			recordedAt: 1, source: 'mark' as const,
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark' as const}
		}
		manager.enqueue(record)
		const circular = {...record} as typeof record & {self?: unknown}
		circular.self = circular
		manager.enqueue(circular)

		expect(manager.getStatus()).toMatchObject({queueSize: 1, droppedTotal: 1})
		expect(observations).toContainEqual({
			name: '_performance_dropped_total', labels: {reason: 'count_limit'}
		})
	})

	it('reports proxy exporter failures without invoking prototype traps', async() => {
		const getPrototypeOf = vi.fn(() => { throw new Error('must not inspect') })
		const failure = new Proxy({}, {getPrototypeOf})
		const report = vi.fn(async() => undefined)
		const manager = createEventExportManager({
			exporters: [{name: 'failed', exporter: {async export() { throw failure }}}],
			maxBufferCount: 1,
			maxBufferBytes: 1_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0,
			errors: {report} as never
		})
		manager.enqueue({
			recordedAt: 1, source: 'mark',
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
		})
		await expect(manager.flush()).rejects.toThrow('flush failed')
		expect(report).toHaveBeenCalled()
		expect(getPrototypeOf).not.toHaveBeenCalled()
		await expect(manager.shutdown()).rejects.toThrow('shutdown failed')
	})

	it('does not report arbitrary exporter failure codes to the errors port', async() => {
		const secret = 'authorization_bearer_super_secret'
		const report = vi.fn(async() => undefined)
		const exportBatch = vi.fn()
			.mockRejectedValueOnce(createPerformanceExportError('failed', {retryable: true, code: secret}))
			.mockResolvedValue(undefined)
		const manager = createEventExportManager({
			exporters: [{name: 'unsafe', exporter: {export: exportBatch}}],
			maxBufferCount: 1, maxBufferBytes: 1_000, flushIntervalMs: 0,
			retryAttempts: 0, retryBaseDelayMs: 0, errors: {report} as never
		})
		manager.enqueue({
			recordedAt: 1, source: 'mark',
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
		})

		await expect(manager.flush()).rejects.toThrow('flush failed')
		expect(JSON.stringify(report.mock.calls)).not.toContain(secret)
		expect(report.mock.calls[0]?.[0]).toMatchObject({message: 'performance_export_failed'})
		await manager.shutdown()
	})

	it('bounds synchronous re-entry from error and observation ports', async() => {
		const invalid: {
			recordedAt: number
			source: 'mark'
			event: {name: string; duration: number; start: number; end: number; source: 'mark'}
			self?: unknown
		} = {
			recordedAt: 1, source: 'mark' as const,
			event: {name: 'invalid', duration: 1, start: 0, end: 1, source: 'mark' as const}
		}
		invalid.self = invalid
		let errorManager!: ReturnType<typeof createEventExportManager>
		const report = vi.fn(() => errorManager.enqueue(invalid))
		errorManager = createEventExportManager({
			exporters: [{name: 'sink', exporter: {async export() {}}}],
			maxBufferCount: 2, maxBufferBytes: 2_000, flushIntervalMs: 0,
			retryAttempts: 0, retryBaseDelayMs: 0, errors: {report} as never
		})
		expect(() => errorManager.enqueue(invalid)).not.toThrow()
		expect(report).toHaveBeenCalledOnce()

		const valid = {
			recordedAt: 1, source: 'mark' as const,
			event: {name: 'valid', duration: 1, start: 0, end: 1, source: 'mark' as const}
		}
		let observationManager!: ReturnType<typeof createEventExportManager>
		const observe = vi.fn((name: string) => {
			if (name === '_performance_export_queue_size') observationManager.enqueue(valid)
		})
		observationManager = createEventExportManager({
			exporters: [{name: 'sink', exporter: {async export() {}}}],
			maxBufferCount: 2, maxBufferBytes: 2_000, flushIntervalMs: 0,
			retryAttempts: 0, retryBaseDelayMs: 0, observe
		})
		expect(() => observationManager.enqueue(valid)).not.toThrow()
		expect(observe).toHaveBeenCalledOnce()
		expect(observationManager.getStatus().queueSize).toBe(2)
		await errorManager.shutdown()
		await observationManager.shutdown()
	})

	it('does not assimilate thenables returned by the error reporter', async() => {
		const readThen = vi.fn(() => { throw new Error('must not assimilate') })
		const manager = createEventExportManager({
			exporters: [{name: 'failed', exporter: {async export() { throw new Error('failed') }}}],
			maxBufferCount: 1,
			maxBufferBytes: 1_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0,
			errors: {report: (() => Object.defineProperty({}, 'then', {get: readThen})) as never}
		})
		manager.enqueue({
			recordedAt: 1, source: 'mark',
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
		})

		await expect(manager.flush()).rejects.toThrow('flush failed')
		expect(readThen).not.toHaveBeenCalled()
		await expect(manager.shutdown()).rejects.toThrow('shutdown failed')
	})

	it('observes rejected telemetry Promises and bounds unresolved error reports', async() => {
		let speciesReads = 0
		class TrackedPromise extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				speciesReads += 1
				return Promise
			}
		}
		const rejectedObservation = new TrackedPromise((_resolve, reject) => reject(new Error('observe failed')))
		const report = vi.fn(() => new Promise<void>(() => undefined))
		const manager = createEventExportManager({
			exporters: [{name: 'failed', exporter: {async export() { throw new Error('failed') }}}],
			maxBufferCount: 1,
			maxBufferBytes: 1_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0,
			errors: {report} as never,
			observe: (() => rejectedObservation) as never
		})
		try {
			manager.enqueue({
				recordedAt: 1, source: 'mark',
				event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
			})
			for (let attempt = 0; attempt < 3; attempt += 1) {
				await expect(manager.flush()).rejects.toThrow('flush failed')
			}
			expect(speciesReads).toBeGreaterThan(0)
			expect(report).toHaveBeenCalledOnce()
		} finally {
			await rejectedObservation.catch(() => undefined)
		}
	})

	it('bounds a never-settling direct export observer to one active callback', async() => {
		const observe = vi.fn(() => new Promise<void>(() => undefined))
		const manager = createEventExportManager({
			exporters: [{name: 'failed', exporter: {async export() { throw new Error('failed') }}}],
			maxBufferCount: 10,
			maxBufferBytes: 10_000,
			flushIntervalMs: 0,
			retryAttempts: 2,
			retryBaseDelayMs: 0,
			observe: observe as never
		})
		for (let index = 0; index < 10; index += 1) {
			manager.enqueue({
				recordedAt: index, source: 'mark',
				event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
			})
		}
		await expect(manager.flush()).rejects.toThrow('flush failed')
		expect(observe).toHaveBeenCalledOnce()
	})

	it('retains ownership of an active export timer when optional unref fails', async() => {
		const timer = {unref: () => { throw new Error('unref unavailable') }}
		const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer as never)
		const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => { throw new Error('clear unavailable') })
		try {
			const manager = createEventExportManager({
				exporters: [{name: 'remote', exporter: {export: vi.fn()}}],
				maxBufferCount: 1, maxBufferBytes: 1_000, flushIntervalMs: 1,
				retryAttempts: 0, retryBaseDelayMs: 0
			})
			await expect(manager.shutdown()).resolves.toBeUndefined()
			expect(clear).toHaveBeenCalledWith(timer)
		} finally {
			interval.mockRestore()
			clear.mockRestore()
		}
	})

	it('does not retry a delivered batch when timeout cleanup fails', async() => {
		const exporter = vi.fn(async() => undefined)
		const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as never)
		const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => { throw new Error('clear unavailable') })
		try {
			const manager = createEventExportManager({
				exporters: [{name: 'remote', exporter: {export: exporter}}],
				maxBufferCount: 1, maxBufferBytes: 1_000, flushIntervalMs: 0,
				retryAttempts: 1, retryBaseDelayMs: 0
			})
			manager.enqueue({
				recordedAt: 1, source: 'mark',
				event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
			})
			await expect(manager.flush()).resolves.toBeUndefined()
			expect(exporter).toHaveBeenCalledOnce()
			expect(manager.getStatus()).toMatchObject({queueSize: 0, retriedTotal: 0})
			await manager.shutdown()
		} finally {
			timer.mockRestore()
			clear.mockRestore()
		}
	})

	it('does not spin on an empty batch when a timed-out delivery succeeds during backoff', async() => {
		vi.useFakeTimers()
		try {
			let release!: () => void
			const exporter = vi.fn()
				.mockImplementationOnce(async() => await new Promise<void>((resolve) => { release = resolve }))
				.mockResolvedValue(undefined)
			const manager = createEventExportManager({
				exporters: [{name: 'late-success', exporter: {export: exporter}}],
				maxBufferCount: 1,
				maxBufferBytes: 1_000,
				flushIntervalMs: 0,
				retryAttempts: 1,
				retryBaseDelayMs: 10,
				operationTimeoutMs: 5
			})
			manager.enqueue({
				recordedAt: 1, source: 'mark',
				event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
			})

			const flushing = manager.flush()
			for (let turn = 0; turn < 5 && exporter.mock.calls.length === 0; turn += 1) {
				await Promise.resolve()
			}
			expect(exporter).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(5)
			release()
			for (let turn = 0; turn < 5 && manager.getStatus().queueSize > 0; turn += 1) {
				await Promise.resolve()
			}
			expect(manager.getStatus().queueSize).toBe(0)
			await vi.advanceTimersByTimeAsync(10)

			await expect(flushing).resolves.toBeUndefined()
			expect(exporter).toHaveBeenCalledOnce()
			await manager.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('rejects the active flush when a timed-out delivery fails terminally during backoff', async() => {
		vi.useFakeTimers()
		try {
			let rejectLate!: (error: unknown) => void
			const exporter = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLate = reject }))
			const manager = createEventExportManager({
				exporters: [{name: 'late-terminal', exporter: {export: exporter}}],
				maxBufferCount: 1,
				maxBufferBytes: 1_000,
				flushIntervalMs: 0,
				retryAttempts: 1,
				retryBaseDelayMs: 10,
				operationTimeoutMs: 5
			})
			manager.enqueue({
				recordedAt: 1, source: 'mark',
				event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
			})

			const flushing = manager.flush()
			void flushing.catch(() => undefined)
			for (let turn = 0; turn < 5 && exporter.mock.calls.length === 0; turn += 1) {
				await Promise.resolve()
			}
			expect(exporter).toHaveBeenCalledOnce()
			await vi.advanceTimersByTimeAsync(5)
			rejectLate(createPerformanceExportError('invalid destination', {
				retryable: false, code: 'http_client_error'
			}))
			for (let turn = 0; turn < 5 && manager.getStatus().queueSize > 0; turn += 1) {
				await Promise.resolve()
			}
			expect(manager.getStatus()).toMatchObject({
				queueSize: 0, droppedTotal: 1, lastFailureCode: 'HTTP_CLIENT_ERROR'
			})
			await vi.advanceTimersByTimeAsync(10)

			await expect(flushing).rejects.toThrow('flush failed')
			expect(exporter).toHaveBeenCalledOnce()
			await manager.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('does not assimilate thenables returned by exporter operations', async() => {
		const readExportThen = vi.fn(() => { throw new Error('must not assimilate export') })
		const exporting = createEventExportManager({
			exporters: [{name: 'hostile', exporter: {
				export: (() => Object.defineProperty({}, 'then', {get: readExportThen})) as never
			}}],
			maxBufferCount: 1, maxBufferBytes: 1_000, flushIntervalMs: 0,
			retryAttempts: 0, retryBaseDelayMs: 0
		})
		exporting.enqueue({
			recordedAt: 1, source: 'mark',
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
		})
		await expect(exporting.flush()).rejects.toThrow('flush failed')
		expect(readExportThen).not.toHaveBeenCalled()
		expect(exporting.getStatus()).toMatchObject({queueSize: 0, lastFailureCode: 'PERFORMANCE_EXPORT_FAILURE'})
		await exporting.shutdown()

		const readShutdownThen = vi.fn(() => { throw new Error('must not assimilate shutdown') })
		const shuttingDown = createEventExportManager({
			exporters: [{name: 'hostile', exporter: {
				async export() {},
				shutdown: (() => Object.defineProperty({}, 'then', {get: readShutdownThen})) as never
			}}],
			maxBufferCount: 1, maxBufferBytes: 1_000, flushIntervalMs: 0,
			retryAttempts: 0, retryBaseDelayMs: 0
		})
		await expect(shuttingDown.shutdown()).rejects.toThrow('shutdown failed')
		expect(readShutdownThen).not.toHaveBeenCalled()
	})

	it('runs exporter shutdown even when its final flush hook times out', async() => {
		vi.useFakeTimers()
		try {
			const flush = vi.fn(() => new Promise<void>(() => undefined))
			const shutdown = vi.fn(async() => undefined)
			const manager = createEventExportManager({
				exporters: [{name: 'cleanup', exporter: {async export() {}, flush, shutdown}}],
				maxBufferCount: 1, maxBufferBytes: 1_000, flushIntervalMs: 0,
				retryAttempts: 0, retryBaseDelayMs: 0, operationTimeoutMs: 5
			})

			const firstShutdown = manager.shutdown()
			void firstShutdown.catch(() => undefined)
			await vi.advanceTimersByTimeAsync(5)
			await expect(firstShutdown).rejects.toThrow('shutdown failed')
			expect(flush).toHaveBeenCalledOnce()
			expect(shutdown).toHaveBeenCalledOnce()
			await expect(manager.shutdown()).resolves.toBeUndefined()
			expect(shutdown).toHaveBeenCalledOnce()
			expect(manager.getStatus().sinkState).toBe('closed')
		} finally { vi.useRealTimers() }
	})

	it('coalesces a burst of concurrent flush requests into bounded drain work', async() => {
		let release!: () => void
		const exportBatch = vi.fn(async() => await new Promise<void>((resolve) => { release = resolve }))
		const manager = createEventExportManager({
			exporters: [{name: 'remote', exporter: {export: exportBatch}}],
			maxBufferCount: 10,
			maxBufferBytes: 10_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0
		})
		manager.enqueue({
			recordedAt: 1, source: 'mark',
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark'}
		})
		const first = manager.flush()
		await vi.waitFor(() => expect(exportBatch).toHaveBeenCalledOnce())
		const burst = Array.from({length: 10_000}, async() => await manager.flush())
		release()

		await Promise.all([first, ...burst])
		expect(exportBatch).toHaveBeenCalledOnce()
		expect(manager.getStatus().queueSize).toBe(0)
		await manager.shutdown()
	})

	it('bounds one flush generation when delivery continuously admits replacement records', async() => {
		const record = {
			recordedAt: 1, source: 'mark' as const,
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark' as const}
		}
		let manager!: ReturnType<typeof createEventExportManager>
		const exporter = vi.fn(async() => {
			manager.enqueue(record)
			if (exporter.mock.calls.length > 5) throw new Error('flush generation did not terminate')
		})
		manager = createEventExportManager({
			exporters: [{name: 'continuous', exporter: {export: exporter}}],
			maxBufferCount: 10,
			maxBufferBytes: 10_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0
		})
		manager.enqueue(record)

		await expect(manager.flush()).resolves.toBeUndefined()
		expect(exporter).toHaveBeenCalledOnce()
		expect(manager.getStatus().queueSize).toBe(1)
		await manager.shutdown()
	})

	it('rejects cyclic exporter prototype traversal without hanging setup', async() => {
		let exporter: object
		const getPrototypeOf = vi.fn(() => exporter)
		exporter = new Proxy({}, {getPrototypeOf})
		await expect(createCustomPerformance({
			destinations: [{name: 'cyclic', exporter: exporter as never}],
			delivery: {flushIntervalMs: 0}
		})).rejects.toThrow('must provide')
		expect(getPrototypeOf).not.toHaveBeenCalled()

		const getOwnPropertyDescriptor = vi.fn(() => { throw new Error('must not inspect') })
		const proxyPrototype = new Proxy({}, {getOwnPropertyDescriptor})
		const inheritedProxyExporter = Object.create(proxyPrototype) as object
		await expect(createCustomPerformance({
			destinations: [{name: 'inherited-proxy', exporter: inheritedProxyExporter as never}],
			delivery: {flushIntervalMs: 0}
		})).rejects.toThrow('must provide')
		expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
	})

	it('bounds materialized exporter batches by record count and serialized bytes', async() => {
		const batches: ReadonlyArray<unknown>[] = []
		const manager = createEventExportManager({
			exporters: [{name: 'recording', exporter: {async export(batch) { batches.push(batch) }}}],
			maxBufferCount: 1_000,
			maxBufferBytes: 5_000_000,
			flushIntervalMs: 0,
			retryAttempts: 0,
			retryBaseDelayMs: 0
		})
		const record = {
			recordedAt: 1,
			source: 'mark' as const,
			event: {name: 'request', duration: 1, start: 0, end: 1, source: 'mark' as const}
		}
		for (let index = 0; index < 600; index += 1) manager.enqueue(record)
		for (let index = 0; index < 3; index += 1) {
			manager.enqueue({...record, event: {...record.event, labels: {padding: 'x'.repeat(600_000)}}})
		}
		manager.enqueue({...record, event: {...record.event, labels: {padding: 'x'.repeat(1_100_000)}}})

		expect(manager.getStatus()).toMatchObject({queueSize: 603, droppedTotal: 1})
		await manager.flush()
		expect(batches.flat()).toHaveLength(603)
		expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(256)
		for (const batch of batches) {
			expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBeLessThan(1_050_000)
		}
		expect(manager.getStatus()).toMatchObject({queueSize: 0, droppedTotal: 1})
		await manager.shutdown()
	})

	it('fans out one logical record into isolated frozen destination batches', async() => {
		const received: unknown[] = []
		const mutating = vi.fn(async(batch: readonly unknown[]) => {
			received.push(batch)
			expect(Object.isFrozen(batch)).toBe(true)
			expect(Object.isFrozen(batch[0])).toBe(true)
		})
		const healthy = vi.fn(async(batch: readonly unknown[]) => { received.push(batch) })
		const performance = await createCustomPerformance({
			clock: createFixedClock(10),
			destinations: [
				{name: 'first', exporter: {export: mutating}},
				{name: 'second', exporter: {export: healthy}}
			],
			delivery: {flushIntervalMs: 0, retry: {attempts: 0, baseDelayMs: 0}}
		})
		performance.record('request', 5, {route: '/safe'})
		expect(performance.getStatus().queueSize).toBe(1)
		await performance.flush()
		expect(performance.getStatus().queueSize).toBe(0)
		expect(mutating).toHaveBeenCalledOnce()
		expect(healthy).toHaveBeenCalledOnce()
		expect(received[0]).not.toBe(received[1])
		await performance.shutdown()
	})

	it('commits a healthy destination independently from a permanent failure', async() => {
		let releaseHealthy!: () => void
		const healthy = vi.fn(async() => await new Promise<void>((resolve) => { releaseHealthy = resolve }))
		const failed = vi.fn(async() => { throw createPerformanceExportError('bad', {retryable: false, code: 'bad_request'}) })
		const performance = await createCustomPerformance({
			clock: createFixedClock(10),
			destinations: [{name: 'healthy', exporter: {export: healthy}}, {name: 'failed', exporter: {export: failed}}],
			delivery: {flushIntervalMs: 0, retry: {attempts: 0, baseDelayMs: 0}}
		})
		performance.record('request', 5)
		const flushing = performance.flush()
		await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
		expect(performance.getStatus()).toMatchObject({queueSize: 1, droppedTotal: 1})
		releaseHealthy()
		await expect(flushing).rejects.toThrow('flush failed')
		expect(healthy).toHaveBeenCalledOnce()
		expect(performance.getStatus()).toMatchObject({
			queueSize: 0, droppedTotal: 1, sinkState: 'unhealthy', lastFailureCode: 'PERFORMANCE_EXPORT_FAILURE'
		})
		await performance.shutdown()
	})

	it('bounds the queue and retries retryable failures', async() => {
		const exporter = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined)
		const performance = await createCustomPerformance({
			clock: createFixedClock(10), destinations: [{name: 'remote', exporter: {export: exporter}}],
			delivery: {maxQueueRecords: 1, flushIntervalMs: 0, retry: {attempts: 1, baseDelayMs: 0}}
		})
		performance.record('first', 1); performance.record('second', 1)
		expect(performance.getStatus()).toMatchObject({queueSize: 1, droppedTotal: 1})
		await performance.flush()
		expect(performance.getStatus()).toMatchObject({queueSize: 0, retriedTotal: 1, sinkState: 'healthy'})
		await performance.shutdown()
	})

	it('performs a real HTTP retry after an asynchronously settled abort', async() => {
		let attempts = 0
		const fetchImpl = vi.fn((_url: string, init?: Parameters<typeof fetch>[1]) => {
			attempts += 1
			if (attempts > 1) return Promise.resolve({ok: true, status: 202} as Response)
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					setTimeout(() => reject(new DOMException('', 'AbortError')), 1)
				})
			})
		})
		const performance = await createCustomPerformance({
			clock: createFixedClock(10),
			destinations: [{
				name: 'http',
				exporter: createHttpNdjsonPerformanceEventExporter({
					url: 'https://collector.example/perf', fetchImpl: fetchImpl as never, timeoutMs: 5
				})
			}],
			delivery: {
				flushIntervalMs: 0, operationTimeoutMs: 50,
				retry: {attempts: 1, baseDelayMs: 5}
			}
		})

		performance.record('request', 1)
		await expect(performance.flush()).resolves.toBeUndefined()
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(performance.getStatus()).toMatchObject({queueSize: 0, retriedTotal: 1, sinkState: 'healthy'})
		await performance.shutdown()
	})

	it('keeps sink state degraded until every concurrent retry finishes', async() => {
		vi.useFakeTimers()
		try {
			const retryable = createPerformanceExportError('temporary', {retryable: true, code: 'temporary'})
			const first = vi.fn().mockRejectedValueOnce(retryable).mockResolvedValue(undefined)
			let rejectSecond!: (error: unknown) => void
			const second = vi.fn()
				.mockImplementationOnce(async() => await new Promise<void>((_resolve, reject) => { rejectSecond = reject }))
				.mockResolvedValue(undefined)
			const performance = await createCustomPerformance({
				clock: createFixedClock(10),
				destinations: [
					{name: 'first', exporter: {export: first}},
					{name: 'second', exporter: {export: second}}
				],
				delivery: {flushIntervalMs: 0, retry: {attempts: 1, baseDelayMs: 1_000}}
			})
			performance.record('request', 1)
			const flushing = performance.flush()
			await vi.waitFor(() => {
				expect(first).toHaveBeenCalledOnce()
				expect(second).toHaveBeenCalledOnce()
			})
			await vi.advanceTimersByTimeAsync(500)
			rejectSecond(retryable)
			await Promise.resolve()
			await vi.advanceTimersByTimeAsync(500)
			await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2))

			expect(second).toHaveBeenCalledOnce()
			expect(performance.getStatus().sinkState).toBe('degraded')
			await vi.advanceTimersByTimeAsync(500)
			await flushing
			expect(second).toHaveBeenCalledTimes(2)
			expect(performance.getStatus().sinkState).toBe('healthy')
			await performance.shutdown()
		} finally { vi.useRealTimers() }
	})

	it('keeps a healthy destination flowing when a retryable peer fills the logical queue', async() => {
		const retryable = createPerformanceExportError('temporary', {retryable: true, code: 'temporary'})
		const blocked = vi.fn()
			.mockRejectedValueOnce(retryable)
			.mockRejectedValueOnce(retryable)
			.mockResolvedValue(undefined)
		const healthy = vi.fn(async() => undefined)
		const performance = await createCustomPerformance({
			clock: createFixedClock(10),
			destinations: [
				{name: 'blocked', exporter: {export: blocked}},
				{name: 'healthy', exporter: {export: healthy}}
			],
			delivery: {maxQueueRecords: 1, flushIntervalMs: 0, retry: {attempts: 0, baseDelayMs: 0}}
		})

		performance.record('first', 1)
		await expect(performance.flush()).rejects.toThrow('flush failed')
		performance.record('second', 1)
		await expect(performance.flush()).rejects.toThrow('flush failed')

		expect(healthy).toHaveBeenCalledTimes(2)
		expect(healthy).toHaveBeenLastCalledWith([
			expect.objectContaining({event: expect.objectContaining({name: 'second'})})
		])
		expect(performance.getStatus()).toMatchObject({queueSize: 1, droppedTotal: 1})
		await performance.shutdown()
	})

	it('keeps failed shutdown draining without restarting background delivery', async() => {
		vi.useFakeTimers()
		try {
			const exporter = vi.fn()
				.mockRejectedValueOnce(new Error('temporary'))
				.mockResolvedValue(undefined)
			const performance = await createCustomPerformance({
				clock: createFixedClock(10), destinations: [{name: 'remote', exporter: {export: exporter}}],
				delivery: {flushIntervalMs: 1_000, retry: {attempts: 0, baseDelayMs: 0}}
			})
			performance.record('request', 1)
			await expect(performance.shutdown()).rejects.toThrow('shutdown failed')
			expect(performance.getStatus()).toMatchObject({state: 'draining', queueSize: 1, sinkState: 'unhealthy'})
			await vi.advanceTimersByTimeAsync(5_000)
			expect(exporter).toHaveBeenCalledOnce()
			await performance.shutdown()
			expect(exporter).toHaveBeenCalledTimes(2)
			expect(performance.getStatus()).toMatchObject({state: 'closed', queueSize: 0, sinkState: 'closed'})
		} finally {
			vi.useRealTimers()
		}
	})

	it('consumes a permanent exporter failure that settles after the caller timeout', async() => {
		let rejectLate!: (error: unknown) => void
		const exporter = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLate = reject }))
		const performance = await createCustomPerformance({
			clock: createFixedClock(10),
			destinations: [{name: 'late-terminal', exporter: {export: exporter}}],
			delivery: {
				flushIntervalMs: 0, operationTimeoutMs: 5,
				retry: {attempts: 0, baseDelayMs: 0}
			}
		})

		performance.record('request', 1)
		await expect(performance.flush()).rejects.toThrow('flush failed')
		rejectLate(createPerformanceExportError('bad request', {
			retryable: false, code: 'http_client_error'
		}))
		await vi.waitFor(() => expect(performance.getStatus()).toMatchObject({
			queueSize: 0, droppedTotal: 1, lastFailureCode: 'HTTP_CLIENT_ERROR'
		}))

		await expect(performance.flush()).resolves.toBeUndefined()
		expect(exporter).toHaveBeenCalledOnce()
		await performance.shutdown()
	})
})
