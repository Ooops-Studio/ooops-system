import {describe, expect, it, vi} from 'vitest'

import {createTransferring} from '../../src/core/transferring'
import {createCustomLogging} from '../../src/public/custom'
import {createDevelopmentLogging} from '../../src/public/development'

const clock = {now: () => 1_000}

describe('managed logging contract', () => {
	it('exposes level mutation only when enabled at bootstrap', async() => {
		const immutable = await createDevelopmentLogging({clock, selfMetrics: false})
		expect('setLevel' in immutable).toBe(false)
		expect(immutable.getStatus()).toMatchObject({
			state: 'running', level: 'debug', mutableLevel: false, sinkState: 'healthy'
		})
		await immutable.shutdown()
		expect(immutable.getStatus().state).toBe('closed')

		const mutable = await createDevelopmentLogging({clock, mutableLevel: true, selfMetrics: false})
		mutable.setLevel('error')
		const child = mutable.context({namespace: 'child'})
		expect(child.level).toBe('error')
		child.setLevel('warn')
		expect(mutable.getStatus()).toMatchObject({level: 'warn', mutableLevel: true})
		await Promise.all([mutable.shutdown(), child.shutdown()])
	})

	it('keeps sampling immutable and always admits protected severity', async() => {
		const lines: string[] = []
		const logger = await createCustomLogging({
			clock,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write: (line) => { lines.push(line) }}}},
			delivery: {mode: 'direct', retry: {maxAttempts: 1, baseDelayMs: 0, multiplier: 1,
				maxDelayMs: 0, jitter: 0, attemptTimeoutMs: 100}},
			sampling: {strategy: 'fixed-rate', rate: 0, keepAtOrAbove: 'error'},
			selfMetrics: false
		})
		logger.info('sampled-out')
		logger.error('retained')
		await logger.flush()
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('retained')
		expect('setSampling' in logger).toBe(false)
		await logger.shutdown()
	})

	it('uses resource enrichment and the declarative custom topology', async() => {
		const lines: string[] = []
		const logger = await createCustomLogging({
			clock,
			format: 'json',
			resource: {serviceName: 'notes', serviceVersion: '2.0.0', deploymentEnvironment: 'test'},
			redaction: {additionalRules: [{path: ['profile', 'nickname'], action: 'truncate', maxBytes: 3}]},
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write: (line) => { lines.push(line) }}}},
			delivery: {mode: 'direct', circuitBreaker: false},
			selfMetrics: false
		})
		logger.info('saved', {profile: {nickname: 'abcdef'}, password: 'secret'})
		await logger.flush()
		const record = JSON.parse(lines[0] as string)
		expect(record.attributes).toMatchObject({
			'service.name': 'notes',
			'service.version': '2.0.0',
			'deployment.environment': 'test',
			profile: {nickname: 'abc…'},
			password: '***'
		})
		await logger.shutdown()
	})

	it('can reserve stdout for an application protocol by routing every local line to stderr', async() => {
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		try {
			const logger = await createCustomLogging({
				clock,
				format: 'json',
				destinations: {consoleStream: 'stderr'},
				selfMetrics: false
			})
			logger.info('bridge-started', {port: 4321})
			logger.error('bridge-failed')
			await logger.flush()
			expect(stdout).not.toHaveBeenCalled()
			expect(stderr).toHaveBeenCalledTimes(2)
			expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain('bridge-started')
			await logger.shutdown()
		} finally {
			stdout.mockRestore()
			stderr.mockRestore()
		}
	})

	it('rejects inapplicable delivery configuration', async() => {
		await expect(createCustomLogging({clock, delivery: {mode: 'batched'}}))
			.rejects.toThrow('require a remote')
		await expect(createCustomLogging({clock, delivery: {mode: 'direct', backpressure: {
			maxQueuedItems: 1, maxQueuedBytes: 1, onOverflow: 'drop-newest'
		}}})).rejects.toThrow('require a remote')
		await expect(createCustomLogging({clock, destinations: {
			stdout: false, consoleStream: 'stderr', remote: {provider: 'custom', sink: {write: vi.fn()}}
		}})).rejects.toThrow('requires stdout')
		await expect(createCustomLogging({clock, destinations: {
			consoleStream: 'invalid' as never
		}})).rejects.toThrow('must be split, stdout, or stderr')
	})

	it('returns sanitized transfer health and counters without recent events', async() => {
		const sink = {write: vi.fn(async() => { throw Object.assign(new Error('secret'), {code: 'REMOTE_DOWN'}) })}
		const transfer = createTransferring({sink, clock})
		transfer.write('line')
		await expect(transfer.flush()).rejects.toThrow('secret')
		expect(transfer.telemetry()).toMatchObject({
			queueSize: 0, writtenTotal: 0, droppedTotal: 0,
			retriedTotal: 0, sinkState: 'unhealthy', lastFailureCode: 'REMOTE_DOWN'
		})
		expect('recent' in transfer).toBe(false)
		expect('markEvent' in transfer).toBe(false)
	})

	it('uses lifecycle health only as enrichment and suppresses low levels only while draining', async() => {
		const lines: string[] = []
		let state: 'running' | 'draining' = 'running'
		let health = 'healthy'
		const lifecycle = {
			getStatus: () => ({state, health, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: () => () => undefined,
			registerFlushHook: () => () => undefined
		}
		const logger = await createCustomLogging({
			clock, level: 'trace', lifecycle: lifecycle as never, selfMetrics: false,
			destinations: {stdout: false, remote: {provider: 'custom', sink: {write: (line) => { lines.push(line) }}}},
			delivery: {mode: 'direct', circuitBreaker: false}
		})
		health = 'unhealthy'
		logger.debug('debug-unhealthy')
		logger.info('info-unhealthy')
		state = 'draining'
		logger.debug('debug-draining')
		logger.info('info-draining')
		await logger.flush()
		expect(lines.join('\n')).toContain('debug-unhealthy')
		expect(lines.join('\n')).toContain('info-unhealthy')
		expect(lines.join('\n')).not.toContain('debug-draining')
		expect(lines.join('\n')).toContain('info-draining')
		expect(logger.getStatus().state).toBe('draining')
		await logger.shutdown()
	})

	it('keeps failed lifecycle cleanup retryable during shutdown', async() => {
		let attempts = 0
		const lifecycle = {
			getStatus: () => ({state: 'running' as const, health: 'healthy' as const, activeHooks: 0, failedChecks: 0}),
			registerShutdownHook: () => () => {
				attempts += 1
				if (attempts === 1) throw new Error('dispose failed')
			},
			registerFlushHook: () => () => undefined
		}
		const logger = await createCustomLogging({clock, lifecycle: lifecycle as never, selfMetrics: false})
		await expect(logger.shutdown()).rejects.toThrow('dispose failed')
		expect(logger.getStatus().state).toBe('draining')
		await expect(logger.shutdown()).resolves.toBeUndefined()
		expect(attempts).toBe(2)
		expect(logger.getStatus().state).toBe('closed')
	})
})
