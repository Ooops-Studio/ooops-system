import {TOK, createContainer} from '@ooopsstudio/core'
import {describe, expect, it, vi} from 'vitest'

import {createErrorHandler} from '../src/core/create-error-handler'
import {registerErrorLifecycleHooks} from '../src/core/lifecycle-hooks'
import {createReportRuntime} from '../src/core/report'
import {classifyError} from '../src/features/classification/classify-error'
import {reportAll} from '../src/features/reporters/report-all'
import {registerErrors} from '../src/index-registration'
import {createCustomErrorHandler} from '../src/public/custom'
import {createSentryErrorSink} from '../src/sentry'
import {
	sanitizeSentryExtra,
	sanitizeSentryTags,
	sanitizeSentryTagValue
} from '../src/sinks/providers/sentry-sanitization'
import type {ErrorsHandlerPort} from '../src/types/error-handler'
import type {EnrichedError} from '../src/types/normalized-error'
import {redactEnrichedError, redactErrorValue} from '../src/utils/redaction'

import {createFixedClock} from './fixed-clock'

const baseError = (code: string): EnrichedError => ({
	kind: 'UnknownError', message: 'failure', code,
	severity: 'error', category: 'UNKNOWN', timestamp: 1
})

describe('errors iterative audit regressions', () => {
	it('contains synchronous sink flush re-entry without self-awaiting its cutoff', async() => {
		let runtime!: ReturnType<typeof createReportRuntime>
		const flush = vi.fn(async() => { await runtime.flush() })
		runtime = createReportRuntime({
			sink: {capture: vi.fn(async() => {}), flush},
			flushTimeoutMs: 5
		})

		await expect(runtime.flush()).resolves.toBeUndefined()
		expect(flush).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('contains synchronous sink close re-entry without self-awaiting shutdown', async() => {
		let runtime!: ReturnType<typeof createReportRuntime>
		const close = vi.fn(async() => { await runtime.shutdown() })
		runtime = createReportRuntime({
			sink: {capture: vi.fn(async() => {}), close},
			shutdownTimeoutMs: 5
		})

		await expect(runtime.shutdown()).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledOnce()
	})

	it('contains synchronous reporter lifecycle re-entry without delaying delivery', async() => {
		let runtime!: ReturnType<typeof createReportRuntime>
		const capture = vi.fn(async() => { await runtime.flush() })
		runtime = createReportRuntime({
			sink: {capture},
			flushTimeoutMs: 5,
			reportTimeoutMs: 10
		})

		await expect(runtime.report(baseError('E_REPORTER_REENTRY'))).resolves.toBeUndefined()
		expect(capture).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it('contains sink flush re-entry through the owning error handler', async() => {
		let handler!: ReturnType<typeof createErrorHandler>
		const flush = vi.fn(async() => { await handler.flush() })
		handler = createErrorHandler({
			clock: createFixedClock(1),
			sink: {capture: vi.fn(async() => {}), flush},
			flushTimeoutMs: 5
		})

		await expect(handler.flush()).resolves.toBeUndefined()
		expect(flush).toHaveBeenCalledOnce()
		await handler.shutdown()
	})

	it('contains sink close re-entry through the owning error handler', async() => {
		let handler!: ReturnType<typeof createErrorHandler>
		const close = vi.fn(async() => { await handler.shutdown() })
		handler = createErrorHandler({
			clock: createFixedClock(1),
			sink: {capture: vi.fn(async() => {}), close},
			shutdownTimeoutMs: 5
		})

		await expect(handler.shutdown()).resolves.toBeUndefined()
		expect(close).toHaveBeenCalledOnce()
	})

	it('contains cache lifecycle re-entry without timing out deduplication', async() => {
		let handler!: ReturnType<typeof createErrorHandler>
		const observe = vi.fn()
		const get = vi.fn(async() => {
			await handler.flush()
			return undefined
		})
		handler = createErrorHandler({
			clock: createFixedClock(1),
			deduplicate: true,
			reportTimeoutMs: 5,
			observe,
			ports: {cache: {get, set: vi.fn(async() => {})}}
		})

		await expect(handler.handle(new Error('cache re-entry'))).resolves.toBeDefined()
		expect(get).toHaveBeenCalledOnce()
		expect(observe).not.toHaveBeenCalledWith(
			'error:reporter', expect.objectContaining({reason: 'deduplication_timeout'})
		)
		await handler.shutdown()
	})

	it('keeps a queued report-runtime flush bounded to its call-time cutoff', async() => {
		let releaseFirstSinkFlush!: () => void
		let firstSinkFlushStarted!: () => void
		const firstSinkStarted = new Promise<void>((resolve) => { firstSinkFlushStarted = resolve })
		const firstSinkGate = new Promise<void>((resolve) => { releaseFirstSinkFlush = resolve })
		let sinkFlushes = 0
		let releaseA!: () => void
		let releaseB!: () => void
		const gateA = new Promise<void>((resolve) => { releaseA = resolve })
		const gateB = new Promise<void>((resolve) => { releaseB = resolve })
		const runtime = createReportRuntime({
			baseReport: async(error) => await (error.code === 'A' ? gateA : gateB),
			sink: {
				capture: async() => {},
				flush: async() => {
					sinkFlushes++
					if (sinkFlushes === 1) {
						firstSinkFlushStarted()
						await firstSinkGate
					}
				}
			},
			reportTimeoutMs: 1_000
		})

		const firstFlush = runtime.flush()
		await firstSinkStarted
		const reportA = runtime.report(baseError('A'))
		const cutoffFlush = runtime.flush()
		const reportB = runtime.report(baseError('B'))
		releaseA()
		releaseFirstSinkFlush()

		await expect(cutoffFlush).resolves.toBeUndefined()
		expect(sinkFlushes).toBe(2)
		releaseB()
		await Promise.all([firstFlush, reportA, reportB])
		await runtime.shutdown()
	})

	it('keeps a queued handler flush bounded to its call-time cutoff', async() => {
		let releaseFirstSinkFlush!: () => void
		let firstSinkFlushStarted!: () => void
		const firstSinkStarted = new Promise<void>((resolve) => { firstSinkFlushStarted = resolve })
		const firstSinkGate = new Promise<void>((resolve) => { releaseFirstSinkFlush = resolve })
		let sinkFlushes = 0
		let releaseA!: () => void
		let releaseB!: () => void
		const gateA = new Promise<void>((resolve) => { releaseA = resolve })
		const gateB = new Promise<void>((resolve) => { releaseB = resolve })
		const handler = createErrorHandler({
			clock: createFixedClock(1),
			report: async(error) => await (error.code === 'A' ? gateA : gateB),
			sink: {
				capture: async() => {},
				flush: async() => {
					sinkFlushes++
					if (sinkFlushes === 1) {
						firstSinkFlushStarted()
						await firstSinkGate
					}
				}
			},
			reportTimeoutMs: 1_000
		})

		const firstFlush = handler.flush()
		await firstSinkStarted
		const handleA = handler.handle(baseError('A'))
		const cutoffFlush = handler.flush()
		const handleB = handler.handle(baseError('B'))
		releaseA()
		releaseFirstSinkFlush()

		await expect(cutoffFlush).resolves.toBeUndefined()
		expect(sinkFlushes).toBe(2)
		releaseB()
		await Promise.all([firstFlush, handleA, handleB])
		await handler.shutdown()
	})

	it('sanitizes container bind and rollback failures', async() => {
		const bindFailure = {
			has: vi.fn(() => false),
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn(() => undefined),
			bind: vi.fn(() => { throw new Error('password=bind-secret') }),
			unbind: vi.fn(() => { throw new Error('token=rollback-secret') })
		} as unknown as Parameters<typeof registerErrors>[0]

		const failure = await registerErrors(bindFailure, {preset: 'custom'})
			.catch((error: unknown) => error as AggregateError)
		expect(failure).toBeInstanceOf(AggregateError)
		expect(failure.message).toBe('Errors registration and rollback failed.')
		expect(JSON.stringify((failure.errors as Error[]).map((error) => error.message)))
			.not.toMatch(/bind-secret|rollback-secret/u)
	})

	it('keeps the production source default when an optional field is explicitly undefined', async() => {
		const handler = await (await import('../src/public/production'))
			.createProductionErrorHandler({defaultSource: undefined})
		const handled = await handler.handle(new Error('production default'))

		expect(handled.source).toBe('production')
		await handler.shutdown()
	})

	it('isolates revoked nested values while preserving safe diagnostic siblings', async() => {
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const handler = createErrorHandler({clock: createFixedClock(1)})

		const handled = await handler.handle({
			name: 'Error', message: 'boom', data: {safe: 'visible', broken: revoked.proxy}
		})

		expect(handled.context).toEqual({safe: 'visible', broken: '[Unserializable]'})
		await handler.shutdown()
	})

	it('omits a revoked top-level data payload without rejecting the application error', async() => {
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const handler = createErrorHandler({clock: createFixedClock(1)})

		await expect(handler.handle({name: 'Error', message: 'boom', data: revoked.proxy}))
			.resolves.toMatchObject({kind: 'Error', message: 'boom'})
		await handler.shutdown()
	})

	it('rejects revoked option and Sentry tag objects with stable public errors', async() => {
		const revokedOptions = Proxy.revocable({}, {})
		revokedOptions.revoke()
		expect(() => createErrorHandler(revokedOptions.proxy as never)).toThrow('errors_invalid_options')

		const revokedTags = Proxy.revocable({}, {})
		revokedTags.revoke()
		expect(() => createSentryErrorSink({
			dsn: 'https://public@example.ingest.sentry.io/42', tags: revokedTags.proxy as never
		})).toThrow('tags must be an object')
	})
	it('does not deduplicate different error kinds with the same message and code', async() => {
		const report = vi.fn(async() => {})
		const handler = createErrorHandler({
			clock: createFixedClock(1), deduplicate: true, report
		})

		await handler.handle(new TypeError('same failure'))
		await handler.handle(new ReferenceError('same failure'))

		expect(report).toHaveBeenCalledTimes(2)
		await handler.shutdown()
	})

	it('redacts IP addresses from structured, free-form, and Sentry diagnostics', () => {
		const redacted = redactErrorValue({
			ip: '203.0.113.42',
			clientIp: '2001:db8::42',
			message: 'request from 198.51.100.7 via 2001:db8:0:0:0:0:0:8'
		})
		const serialized = JSON.stringify(redacted)

		for (const address of [
			'203.0.113.42', '2001:db8::42', '198.51.100.7', '2001:db8:0:0:0:0:0:8'
		]) expect(serialized).not.toContain(address)
		expect(sanitizeSentryTagValue('peer', '203.0.113.42')).toMatch(/^ip:/u)
		expect(sanitizeSentryTagValue('peer', '2001:db8::42')).toMatch(/^ip:/u)
	})

	it('redacts common identity and address PII across diagnostic projections', () => {
		const redacted = redactErrorValue({
			firstName: 'Alice', lastName: 'Example', dateOfBirth: '1990-01-02',
			shippingAddress: '1 Private Street',
			message: 'full_name="Alice Example" dob=1990-01-02 billing_address="1 Private Street"',
			filename: 'diagnostic.txt'
		}) as Record<string, unknown>
		const serialized = JSON.stringify(redacted)

		for (const value of ['Alice', 'Example', '1990-01-02', '1 Private Street']) {
			expect(serialized).not.toContain(value)
		}
		expect(redacted.filename).toBe('diagnostic.txt')
		expect(sanitizeSentryTagValue('first_name', 'Alice')).toMatch(/^pii:/u)
		const tags = sanitizeSentryTags({firstName: 'Alice'})
		expect(sanitizeSentryTags(tags)).toEqual(tags)
		expect(sanitizeSentryExtra({dateOfBirth: '1990-01-02'}))
			.toEqual({dateOfBirth: '[DROPPED]'})
	})

	it('hashes structured identifier names and slugs as consistently as identifier ids', () => {
		const redacted = redactErrorValue({
			username: 'alice',
			tenantName: 'acme',
			workspaceSlug: 'private-workspace',
			projectKey: 'project-secret',
			nested: {actorUserName: 'bob'}
		}) as Record<string, unknown>

		for (const key of ['username', 'tenantName', 'workspaceSlug', 'projectKey']) {
			expect(redacted[key]).toMatch(/^hash:[0-9a-f]{8}$/u)
		}
		expect((redacted.nested as Record<string, unknown>).actorUserName)
			.toMatch(/^hash:[0-9a-f]{8}$/u)
		expect(JSON.stringify(redacted)).not.toMatch(/alice|acme|private-workspace|project-secret|bob/u)
	})

	it('keeps identifier fingerprints stable across repeated delivery boundaries', () => {
		const first = redactEnrichedError({
			...baseError('E_UNKNOWN'),
			context: {userId: 'user-12345', requestId: 'request-67890'},
			data: {tenantId: 'tenant-24680'}
		})

		expect(redactEnrichedError(first)).toEqual(first)
		expect(redactEnrichedError(redactEnrichedError(first))).toEqual(first)
	})

	it('redacts complete escaped quoted credential and identifier assignments', () => {
		const redacted = redactErrorValue({
			message: 'password="prefix\\"secret-tail" userId=\'actor\\\'private-tail\''
		})
		const serialized = JSON.stringify(redacted)

		expect(serialized).not.toContain('prefix')
		expect(serialized).not.toContain('secret-tail')
		expect(serialized).not.toContain('actor')
		expect(serialized).not.toContain('private-tail')
		expect(serialized).toContain('[REDACTED]')
		expect(serialized).toContain('[DROPPED]')
	})

	it('fails closed for unterminated or malformed quoted assignments', () => {
		const credential = JSON.stringify(redactErrorValue('password="prefix"secret-tail'))
		const identifier = JSON.stringify(redactErrorValue("userId='actor-private-tail"))

		expect(credential).not.toContain('prefix')
		expect(credential).not.toContain('secret-tail')
		expect(identifier).not.toContain('actor-private-tail')
	})

	it('redacts authorization schemes before assignment parsing can detach their tokens', () => {
		const redacted = JSON.stringify(redactErrorValue(
			'Authorization: Bearer short:secret!tail, proxyAuthorization=Basic dXNlcjpwYXNz'
		))

		expect(redacted).not.toContain('short:secret!tail')
		expect(redacted).not.toContain('dXNlcjpwYXNz')
	})

	it('redacts complete multi-part authorization and cookie header values', () => {
		const redacted = JSON.stringify(redactErrorValue([
			'Authorization: Digest username=admin, realm=private, response=deadbeef',
			'Authorization: Digest username=admin,\r\n response=folded-secret',
			'Cookie: session=abc; theme=private-value',
			'Set-Cookie: auth=server-cookie; Path=/; HttpOnly',
			'Proxy-Authorization: Negotiate short-secret trailing-private'
		].join('\n')))

		for (const secret of [
			'admin', 'private', 'deadbeef', 'session=abc',
			'private-value', 'folded-secret', 'server-cookie',
			'short-secret', 'trailing-private'
		]) expect(redacted).not.toContain(secret)
	})

	it('keeps full-line credential header redaction bounded near the scan ceiling', () => {
		const value = `Authorization: Digest ${'x '.repeat(30_000)}`
		expect(redactErrorValue(value)).toBe('Authorization=[REDACTED]')
	})

	it('rejects hidden registration configuration without reading it', async() => {
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		const hidden = {} as Record<string, unknown>
		Object.defineProperty(hidden, 'preset', {value: 'development', enumerable: false})

		await expect(registerErrors(container, hidden as never)).rejects.toThrow('Unknown errors preset')
		expect(container.has(TOK.Errors)).toBe(false)
	})

	it('keeps the lifecycle signal callback out of custom public configuration', async() => {
		await expect(createCustomErrorHandler({onHandled: vi.fn()} as never))
			.rejects.toThrow('errors_invalid_options')

		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		await expect(registerErrors(container, {
			preset: 'custom', options: {onHandled: vi.fn()} as never
		})).rejects.toThrow('errors_invalid_options')
		expect(container.has(TOK.Errors)).toBe(false)
	})

	it('does not expose container lookup or dependency failures during registration', async() => {
		const base = {
			has: vi.fn(() => false), bind: vi.fn(), unbind: vi.fn(() => false)
		}
		const lookupFailure = {
			...base,
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn(() => { throw new Error('token=lookup-secret') })
		} as unknown as Parameters<typeof registerErrors>[0]
		const lookupError = await registerErrors(lookupFailure, {preset: 'custom'})
			.catch((error: unknown) => error as Error)
		expect(lookupError.message).toBe('errors_container_lookup_failed')
		expect(lookupError.message).not.toContain('lookup-secret')

		const clockFailure = {
			...base,
			get: vi.fn(() => { throw new Error('password=clock-secret') }),
			tryGet: vi.fn(() => undefined)
		} as unknown as Parameters<typeof registerErrors>[0]
		const clockError = await registerErrors(clockFailure, {preset: 'custom'})
			.catch((error: unknown) => error as Error)
		expect(clockError.message).toBe('errors_invalid_clock')
		expect(clockError.message).not.toContain('clock-secret')

		const dependencyFailure = {
			...base,
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token: symbol) => {
				if (token === TOK.Errors) return undefined
				throw new Error('authorization=dependency-secret')
			})
		} as unknown as Parameters<typeof registerErrors>[0]
		const dependencyError = await registerErrors(dependencyFailure, {preset: 'custom'})
			.catch((error: unknown) => error as Error)
		expect(dependencyError.message).toBe('errors_dependency_resolution_failed')
		expect(dependencyError.message).not.toContain('dependency-secret')
	})

	it('acquires the registration guard before caller-controlled container lookups', async() => {
		let service: unknown
		let nested: Promise<void> | undefined
		let reentered = false
		const container = {
			has(token: symbol) {
				if (!reentered) {
					reentered = true
					nested = registerErrors(container as never, {preset: 'custom'})
					void nested.catch(() => undefined)
				}
				return token === TOK.Errors && service !== undefined
			},
			get: vi.fn(() => createFixedClock(1)),
			tryGet: vi.fn((token: symbol) => token === TOK.Errors ? service : undefined),
			bind: vi.fn((_token: symbol, value: unknown) => { service = value }),
			unbind: vi.fn(() => { service = undefined; return true })
		}

		await expect(registerErrors(container as never, {preset: 'custom'})).resolves.toBeUndefined()
		await expect(nested).rejects.toThrow('errors_already_registered')
		expect(service).toBeDefined()
		await (service as ErrorsHandlerPort).shutdown()
	})

	it('acquires the registration guard before proxy capability inspection', async() => {
		const base = createContainer()
		base.bind(TOK.Clock, createFixedClock(1))
		let nested: Promise<void> | undefined
		let reentered = false
		const container = new Proxy(base, {
			getOwnPropertyDescriptor(target, property) {
				if (!reentered && property === 'has') {
					reentered = true
					nested = registerErrors(container, {preset: 'development'})
					void nested.catch(() => undefined)
				}
				return Reflect.getOwnPropertyDescriptor(target, property)
			}
		})

		await registerErrors(container, {preset: 'development'})
		await expect(nested).rejects.toThrow('errors_already_registered')
		expect(base.has(TOK.Errors)).toBe(true)
		await (base.get(TOK.Errors) as ErrorsHandlerPort).shutdown()
	})

	it('never invokes array get traps while redacting error context', async() => {
		const get = vi.fn((_target: unknown[], key: PropertyKey, receiver: unknown) =>
			Reflect.get(_target, key, receiver))
		const tags = new Proxy(['safe'], {get})
		const handler = createErrorHandler({clock: createFixedClock(1)})

		const result = await handler.handle(new Error('array context'), {tags})

		expect(result.context?.tags).toEqual(['safe'])
		expect(get).not.toHaveBeenCalled()
		await handler.shutdown()
	})

	it('does not expose non-enumerable context, data, Sentry tags, or extra fields', async() => {
		const context = {visible: 'ok'} as Record<string, unknown>
		Object.defineProperty(context, 'hiddenContext', {
			value: 'password=hidden-context-secret', enumerable: false
		})
		const data = {visibleData: 'ok'} as Record<string, unknown>
		Object.defineProperty(data, 'hiddenData', {
			value: 'token=hidden-data-secret', enumerable: false
		})
		const tags = {visible: 'safe'} as Record<string, string>
		Object.defineProperty(tags, 'hiddenTag', {
			value: 'tenant-private', enumerable: false
		})
		const extra = {visibleExtra: 'ok'} as Record<string, unknown>
		Object.defineProperty(extra, 'hiddenExtra', {
			value: 'api_key=hidden-extra-secret', enumerable: false
		})
		const handler = createErrorHandler({clock: createFixedClock(1)})

		const handled = await handler.handle({
			kind: 'Error', message: 'safe', data
		}, context)

		expect(handled.context).toEqual({visibleData: 'ok', visible: 'ok'})
		expect(sanitizeSentryTags(tags)).toEqual({visible: 'safe'})
		expect(sanitizeSentryExtra(extra)).toEqual({visibleExtra: 'ok'})
		expect(JSON.stringify({handled, tags: sanitizeSentryTags(tags), extra: sanitizeSentryExtra(extra)}))
			.not.toContain('hidden-')
		await handler.shutdown()
	})

	it('isolates hostile nested redaction nodes without dropping safe siblings', () => {
		const hostileKeys = new Proxy({}, {
			ownKeys() { throw new Error('nested ownKeys trap') }
		})
		const hostileDescriptor = new Proxy({safeNested: 'kept', blocked: 'secret'}, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'blocked') throw new Error('nested descriptor trap')
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})

		expect(redactErrorValue({safe: 'kept', hostileKeys, hostileDescriptor})).toEqual({
			safe: 'kept',
			hostileKeys: '[Unserializable]',
			hostileDescriptor: {safeNested: 'kept'}
		})
	})

	it('never reads callable names through a hostile get trap', () => {
		const get = vi.fn((_target: () => void, key: PropertyKey, receiver: unknown) =>
			Reflect.get(_target, key, receiver))
		const callable = new Proxy(function task() {}, {get})

		expect(redactErrorValue({callable})).toMatchObject({callable: '[Function:task]'})
		expect(get).not.toHaveBeenCalled()
	})

	it('bounds a never-settling observer to one invocation across report generations', async() => {
		const observe = vi.fn(() => new Promise<void>(() => undefined))
		const runtime = createReportRuntime({
			baseReport: vi.fn(async() => {}), observe, reportTimeoutMs: 50
		})

		await Promise.all(Array.from({length: 200}, (_value, index) =>
			runtime.report(baseError(`E_OBSERVER_${index}`))
		))

		expect(observe).toHaveBeenCalledOnce()
		await runtime.shutdown()
	})

	it.each([
		['logging', 'log'],
		['metrics', 'metrics'],
		['tracing', 'trace']
	] as const)('does not count a suppressed %s feedback path as delivered', async(source, suppressed) => {
		const logger = {error: vi.fn()}
		const metrics = {increment: vi.fn()}
		const tracer = {recordException: vi.fn(), addBreadcrumb: vi.fn()}
		const result = await reportAll({...baseError('E_UNKNOWN'), source}, {
			logger: logger as never,
			metrics: metrics as never,
			tracer: tracer as never
		})

		expect(result).toEqual({configured: 2, delivered: 2, failed: 0})
		if (suppressed === 'log') expect(logger.error).not.toHaveBeenCalled()
		if (suppressed === 'metrics') expect(metrics.increment).not.toHaveBeenCalled()
		if (suppressed === 'trace') {
			expect(tracer.recordException).not.toHaveBeenCalled()
			expect(tracer.addBreadcrumb).not.toHaveBeenCalled()
		}
	})

	it('does not invoke accessor-backed lifecycle registration capabilities', () => {
		const getter = vi.fn(() => { throw new Error('must not execute') })
		const lifecycle = Object.create(null) as Record<string, unknown>
		Object.defineProperty(lifecycle, 'registerFlushHook', {get: getter})
		Object.defineProperty(lifecycle, 'registerShutdownHook', {get: getter})

		expect(() => registerErrorLifecycleHooks(lifecycle as never, {
			flush: vi.fn(async() => {}), shutdown: vi.fn(async() => {})
		})).toThrow('errors_lifecycle_registration_failed')
		expect(getter).not.toHaveBeenCalled()
	})

	it('registers shutdown in the ordered observability group', async() => {
		let shutdownHook: (() => Promise<void>) | undefined
		const dispose = vi.fn()
		const shutdown = vi.fn(async() => {})
		const groupedRegistration = vi.fn((_group, hook) => {
			shutdownHook = async() => { await hook({} as never) }
			return dispose
		})
		const unregister = registerErrorLifecycleHooks({
			registerFlushHook: vi.fn(() => vi.fn()),
			registerShutdownHook: groupedRegistration
		} as never, {flush: vi.fn(async() => {}), shutdown})

		await shutdownHook?.()
		expect(shutdown).toHaveBeenCalledOnce()
		expect(groupedRegistration).toHaveBeenCalledWith('observability', expect.any(Function), {name: 'errors'})
		unregister()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('matches classification codes on complete machine-token boundaries only', () => {
		expect(classifyError(baseError('EACCES')).category).toBe('AUTHORIZATION')
		expect(classifyError(baseError('EPERM')).category).toBe('AUTHORIZATION')
		expect(classifyError(baseError('UPSTREAM_TIMEOUT_RETRY')).category).toBe('TIMEOUT')
		expect(classifyError(baseError('UPSTREAMTIMEOUTRETRY')).category).toBe('UNKNOWN')
		expect(classifyError(baseError('EACCESSED')).category).toBe('UNKNOWN')
		expect(classifyError(baseError('ÉTIMEOUTÉ')).category).toBe('UNKNOWN')
		expect(classifyError(baseError('πEACCESπ')).category).toBe('UNKNOWN')
		expect(classifyError(baseError('𐐀TIMEOUT𐐀')).category).toBe('UNKNOWN')
	})

	it('redacts free-form colon assignments and caller-controlled metadata keys', () => {
		const result = redactErrorValue({
			'user@example.com': 'ok',
			message: 'password: hunter2 api_key:"short-secret"',
			json: '"password": "hello world" client_secret: tiny-secret'
		}) as Record<string, unknown>

		const serialized = JSON.stringify(result)
		expect(serialized).not.toContain('user@example.com')
		expect(serialized).not.toContain('hunter2')
		expect(serialized).not.toContain('short-secret')
		expect(serialized).not.toContain('hello world')
		expect(serialized).not.toContain('tiny-secret')
		expect(result.message.match(/\[REDACTED\]/gu)).toHaveLength(2)
	})

	it('redacts secrets and identity data behind long or compound assignment keys', () => {
		const longCredentialKey = `${'integration'.repeat(20)}Password`
		const input = [
			`${longCredentialKey}=short-secret`,
			'actorUserId=user-private-123',
			'customerBillingAddress="1 Private Street"',
			'checkoutContactEmail=person@example.com',
			'safe=secondaryUserId=nested-user-private',
			'note=deliveryShippingAddress="2 Nested Street"'
		].join(' ')
		const redacted = String(redactErrorValue(input))

		for (const privateValue of [
			'short-secret', 'user-private-123', '1 Private Street', 'person@example.com',
			'nested-user-private', '2 Nested Street'
		]) expect(redacted).not.toContain(privateValue)
	})

	it('keeps compound assignment redaction bounded across many small fields', () => {
		const input = Array.from({length: 1_500}, (_value, index) =>
			`safe${index}=ok actorUserId=private-user-${index}`
		).join(' ')
		const redacted = String(redactErrorValue(input))

		expect(input.length).toBeLessThan(65_536)
		expect(redacted).toContain('safe0=ok')
		expect(redacted.match(/\[DROPPED\]/gu)?.length).toBeGreaterThan(100)
		expect(redacted).not.toContain('private-user-0')
		expect(redacted).not.toContain('private-user-1499')
	})

	it('keeps long credential-key scans bounded when no assignment exists', () => {
		const longKeyWithoutValue = `${'a'.repeat(64_000)}password`
		const manyCandidatesWithoutValues = Array.from({length: 5_000}, () => 'password').join(' ')

		expect(redactErrorValue(longKeyWithoutValue)).toBeTypeOf('string')
		expect(redactErrorValue(manyCandidatesWithoutValues)).toBeTypeOf('string')
	})

	it('redacts punctuation and zero-width obfuscated credential assignments', () => {
		const input = [
			'pass_word=underscore-secret',
			'pass-word=hyphen-secret',
			'pass.word=dot-secret',
			'pass\u200Bword=zero-width-secret',
			'api.key=api-secret',
			'pass/word=slash-secret',
			'pass+word=plus-secret',
			'pass\u00ADword=soft-hyphen-secret',
			'pass\uFEFFword=byte-order-mark-secret',
			'pass✨word=emoji-secret',
			'pass  word=space-secret',
			'api \t key=tab-secret',
			'client\u00A0 \u00A0secret=non-breaking-space-secret',
			'pass \u200B word=mixed-separator-secret'
		].join(' ')
		const redacted = String(redactErrorValue(input))

		for (const secret of [
			'underscore-secret', 'hyphen-secret', 'dot-secret', 'zero-width-secret', 'api-secret',
			'slash-secret', 'plus-secret', 'soft-hyphen-secret', 'byte-order-mark-secret',
			'emoji-secret', 'space-secret', 'tab-secret', 'non-breaking-space-secret',
			'mixed-separator-secret'
		]) expect(redacted).not.toContain(secret)
	})

	it('keeps compound identity values out of custom and Sentry delivery', async() => {
		const report = vi.fn(async() => {})
		const handler = createErrorHandler({clock: createFixedClock(1), report})
		await handler.handle(new Error(
			'actorUserId=custom-private-user pass\u200Bword=custom-private-secret'
		))
		const customDelivery = JSON.stringify(report.mock.calls)
		expect(customDelivery).not.toContain('custom-private-user')
		expect(customDelivery).not.toContain('custom-private-secret')
		await handler.shutdown()

		let body = ''
		vi.stubGlobal('fetch', vi.fn(async(_url: string, init?: {body?: unknown}) => {
			body = String(init?.body ?? '')
			return new Response('', {status: 200})
		}))
		try {
			const sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
			await sink.capture({
				...baseError('E_UNKNOWN'),
				message: 'customerBillingAddress=3 Private Road api.key=sentry-private-secret'
			})
			expect(body).not.toContain('3 Private Road')
			expect(body).not.toContain('sentry-private-secret')
			await sink.close?.()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('does not let an abort-ignoring fetch poison Sentry flush or close', async() => {
		vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
		try {
			const sink = createSentryErrorSink({
				dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 1
			})
			await expect(sink.capture(baseError('E_UNKNOWN'))).rejects.toMatchObject({
				code: 'SENTRY_REQUEST_TIMEOUT'
			})
			await expect(sink.flush?.()).resolves.toBeUndefined()
			await expect(sink.close?.()).resolves.toBeUndefined()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('honours explicit registration integrations instead of silently replacing them', async() => {
		const containerLogger = {error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn()}
		const explicitLogger = {error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn()}
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		container.bind(TOK.Logging, containerLogger as never)
		await registerErrors(container, {
			preset: 'custom',
			options: {clock: createFixedClock(2), ports: {logger: explicitLogger as never}}
		})

		const errors = container.get(TOK.Errors) as unknown as ErrorsHandlerPort
		const handled = await errors.handle(new Error('explicit'))
		expect(handled.timestamp).toBe(2)
		expect(explicitLogger.error).toHaveBeenCalledOnce()
		expect(containerLogger.error).not.toHaveBeenCalled()
		await errors.shutdown()
	})

	it('does not let undefined optional ports erase injected container integrations', async() => {
		const containerLogger = {error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn()}
		const container = createContainer()
		container.bind(TOK.Clock, createFixedClock(1))
		container.bind(TOK.Logging, containerLogger as never)
		await registerErrors(container, {
			preset: 'custom', options: {ports: {logger: undefined} as never}
		})

		const errors = container.get(TOK.Errors) as unknown as ErrorsHandlerPort
		await errors.handle(new Error('injected logger remains active'))

		expect(containerLogger.error).toHaveBeenCalledOnce()
		await errors.shutdown()
	})

	it('keeps timed-out physical reports inside the admission cap until they settle', async() => {
		vi.useFakeTimers()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const baseReport = vi.fn(async() => { await gate })
		const observe = vi.fn()
		const runtime = createReportRuntime({baseReport, observe, reportTimeoutMs: 1})
		try {
			const accepted = Array.from({length: 1_000}, () => runtime.report(baseError('E_UNKNOWN')))
			await Promise.resolve()
			expect(baseReport).toHaveBeenCalledTimes(1_000)
			const ownKeys = vi.fn(() => { throw new Error('capacity path inspected the error') })
			await expect(runtime.report(new Proxy(baseError('E_OVER_CAP'), {ownKeys}) as never)).resolves.toBeUndefined()
			expect(ownKeys).not.toHaveBeenCalled()
			expect(observe).toHaveBeenCalledWith('error:reporter', expect.objectContaining({
				reason: 'report_capacity',
				error: expect.objectContaining({message: 'Report capacity exceeded.'})
			}))

			await vi.advanceTimersByTimeAsync(1)
			await Promise.allSettled(accepted)
			await expect(runtime.report(baseError('E_STILL_OVER_CAP'))).resolves.toBeUndefined()
			expect(baseReport).toHaveBeenCalledTimes(1_000)

			release()
			await vi.runAllTimersAsync()
			await runtime.shutdown()
		} finally {
			vi.useRealTimers()
		}
	}, 15_000)

	it('establishes report ownership before a synchronous reporter can re-enter', async() => {
		let runtime!: ReturnType<typeof createReportRuntime>
		let reentries = 0
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const observe = vi.fn()
		const baseReport = vi.fn(async() => {
			if (reentries++ < 1_200) void runtime.report(baseError('E_REENTRANT'))
			await gate
		})
		runtime = createReportRuntime({baseReport, observe, reportTimeoutMs: 5_000})

		const initial = runtime.report(baseError('E_INITIAL'))
		await vi.waitFor(() => expect(observe).toHaveBeenCalledWith(
			'error:reporter', expect.objectContaining({reason: 'report_capacity'})
		))
		expect(baseReport).toHaveBeenCalledTimes(1_000)
		release()
		await initial
		await runtime.shutdown()
	})

	it('establishes report ownership before hostile payload inspection can re-enter', async() => {
		let runtime!: ReturnType<typeof createReportRuntime>
		let reentries = 0
		const nested: Promise<void>[] = []
		const baseReport = vi.fn(async() => {})
		const observe = vi.fn()
		const target = baseError('E_SNAPSHOT_REENTRANT')
		let hostile!: EnrichedError
		hostile = new Proxy(target, {
			getOwnPropertyDescriptor(current, key) {
				if (key === 'message' && reentries++ < 1_050) {
					const operation = runtime.report(hostile)
					nested.push(operation)
					void operation.catch(() => undefined)
				}
				return Reflect.getOwnPropertyDescriptor(current, key)
			}
		})
		runtime = createReportRuntime({baseReport, observe, reportTimeoutMs: 5_000})

		const initial = runtime.report(hostile)
		await Promise.allSettled([initial, ...nested])

		expect(baseReport).toHaveBeenCalledOnce()
		expect(observe).toHaveBeenCalledWith(
			'error:reporter', expect.objectContaining({reason: 'report_capacity'})
		)
		await runtime.shutdown()
	})

	it('caps active Sentry requests during an error storm', async() => {
		vi.useFakeTimers()
		const fetch = vi.fn(() => new Promise(() => undefined))
		vi.stubGlobal('fetch', fetch)
		try {
			const sink = createSentryErrorSink({
				dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 1
			})
			const accepted = Array.from({length: 100}, () => sink.capture(baseError('E_UNKNOWN')))
			await expect(sink.capture(baseError('E_UNKNOWN'))).rejects.toMatchObject({
				code: 'SENTRY_SINK_OVERLOADED'
			})
			await vi.advanceTimersByTimeAsync(1)
			const outcomes = await Promise.allSettled(accepted)
			expect(outcomes).toHaveLength(100)
			await expect(sink.capture(baseError('E_STILL_OVERLOADED'))).rejects.toMatchObject({
				code: 'SENTRY_SINK_OVERLOADED'
			})
			expect(fetch).toHaveBeenCalledTimes(100)
		} finally {
			vi.useRealTimers()
			vi.unstubAllGlobals()
		}
	})

	it('owns a Sentry capture before synchronous fetch re-entry', async() => {
		vi.useFakeTimers()
		let sink!: ReturnType<typeof createSentryErrorSink>
		const reentrantCaptures: Promise<void>[] = []
		const fetch = vi.fn(() => {
			const nested = sink.capture(baseError('E_REENTRANT'))
			reentrantCaptures.push(nested)
			void nested.catch(() => undefined)
			return new Promise(() => undefined)
		})
		vi.stubGlobal('fetch', fetch)
		try {
			sink = createSentryErrorSink({
				dsn: 'https://public@example.ingest.sentry.io/42', requestTimeoutMs: 1
			})
			const initial = sink.capture(baseError('E_INITIAL'))
			void initial.catch(() => undefined)
			for (let index = 0; index < 110; index += 1) await Promise.resolve()

			expect(fetch).toHaveBeenCalledTimes(100)
			await expect(reentrantCaptures.at(-1)).rejects.toMatchObject({
				code: 'SENTRY_SINK_OVERLOADED'
			})
			await vi.advanceTimersByTimeAsync(1)
			await Promise.allSettled([initial, ...reentrantCaptures])
			await sink.close?.()
		} finally {
			vi.useRealTimers()
			vi.unstubAllGlobals()
		}
	})

	it('contains synchronous Sentry fetch lifecycle re-entry', async() => {
		let sink!: ReturnType<typeof createSentryErrorSink>
		const fetch = vi.fn(async() => {
			const nestedFlush = sink.flush?.()
			const nestedClose = sink.close?.()
			await Promise.all([nestedFlush, nestedClose])
			return new Response('', {status: 200})
		})
		vi.stubGlobal('fetch', fetch)
		try {
			sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})
			const settled = await Promise.race([
				sink.capture(baseError('E_LIFECYCLE_REENTRY')).then(() => true),
				new Promise<false>((resolve) => { setTimeout(() => resolve(false), 100) })
			])

			expect(settled).toBe(true)
			expect(fetch).toHaveBeenCalledOnce()
			await expect(sink.close?.()).resolves.toBeUndefined()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('owns a Sentry capture before hostile payload inspection can re-enter', async() => {
		let sink!: ReturnType<typeof createSentryErrorSink>
		let reentries = 0
		const nested: Promise<void>[] = []
		const fetch = vi.fn(async() => new Response('', {status: 200}))
		vi.stubGlobal('fetch', fetch)
		try {
			const target = baseError('E_SNAPSHOT_REENTRANT')
			let hostile!: EnrichedError
			hostile = new Proxy(target, {
				getOwnPropertyDescriptor(current, key) {
					if (key === 'message' && reentries++ < 120) {
						const operation = sink.capture(hostile)
						nested.push(operation)
						void operation.catch(() => undefined)
					}
					return Reflect.getOwnPropertyDescriptor(current, key)
				}
			})
			sink = createSentryErrorSink({dsn: 'https://public@example.ingest.sentry.io/42'})

			const initial = sink.capture(hostile)
			const outcomes = await Promise.allSettled([initial, ...nested])

			expect(fetch).toHaveBeenCalledOnce()
			expect(outcomes.some((outcome) => outcome.status === 'rejected'
				&& (outcome.reason as {code?: string}).code === 'SENTRY_SINK_OVERLOADED')).toBe(true)
			await sink.close?.()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('snapshots mutable inputs synchronously and normalizes each handle once', async() => {
		let nowCalls = 0
		const report = vi.fn(async() => {})
		const handler = createErrorHandler({
			clock: {now: () => { nowCalls++; return nowCalls }}, report
		})
		const input = {kind: 'Error', message: 'before'}
		const context = {request: 'before'}
		const pending = handler.handle(input, context)
		input.message = 'after'
		context.request = 'after'

		await expect(pending).resolves.toMatchObject({
			message: 'before', timestamp: 1, context: {request: 'before'}
		})
		expect(nowCalls).toBe(1)
		expect(report).toHaveBeenCalledWith(expect.objectContaining({message: 'before'}))
	})

	it('normalizes identifier-valued Sentry tags from their semantic key', () => {
		expect(sanitizeSentryTagValue('tenant', 'acme')).toMatch(/^id:/u)
		expect(sanitizeSentryTagValue('user_id', 'alice')).toMatch(/^id:/u)
		expect(sanitizeSentryTagValue('workspace_slug', 'acme')).toMatch(/^id:/u)
		expect(sanitizeSentryTagValue('email', 'alice')).toBe('email')
		expect(sanitizeSentryTagValue('server_name', 'tenant-a.internal')).toMatch(/^server:/u)
		const once = sanitizeSentryTags({
			userId: 'alice', source: 'customer-secret', serverName: 'tenant-a.internal'
		})
		expect(sanitizeSentryTags(once)).toEqual(once)
	})

	it('keeps caller-controlled custom error codes out of indexed Sentry tags', () => {
		expect(sanitizeSentryTagValue('code', 'E_UNKNOWN')).toBe('E_UNKNOWN')
		expect(sanitizeSentryTagValue('code', 'TENANT_ACME_FAILURE')).toBe('custom')
		expect(sanitizeSentryTagValue('code', 'short-random-id')).toBe('custom')
		expect(sanitizeSentryTagValue('Code', 'TENANT_ACME_FAILURE')).toBe('custom')
		expect(sanitizeSentryTagValue('SOURCE', 'customer-secret')).toMatch(/^source:/u)
	})

	it('drops separator-obfuscated credential tags and redacts matching extra keys', () => {
		expect(sanitizeSentryTags({
			pass_word: 'hunter2',
			'api key': 'abc123',
			'set-cookie': 'session=short-secret',
			safe: 'value'
		})).toEqual({safe: 'value'})
		const extra = sanitizeSentryExtra({
			pass_word: 'hunter2', nested: {'api key': 'abc123'}
		})
		const serialized = JSON.stringify(extra)
		expect(serialized).toContain('[REDACTED]')
		expect(serialized).not.toContain('hunter2')
		expect(serialized).not.toContain('abc123')
	})

	it('redacts credential fields and compound PII or identifier Sentry keys', () => {
		const structured = redactErrorValue({
			auth: 'short-auth-value',
			credentials: 'short-credential',
			serviceCredentialStatus: 'still-secret',
			tenant: 'tenant-a',
			workspace: 'workspace-a',
			session: 'session-a',
			author: 'safe-author',
			accounting: 'safe-accounting'
		}) as Record<string, unknown>
		expect(structured.auth).toBe('[REDACTED]')
		expect(structured.credentials).toBe('[REDACTED]')
		expect(structured.serviceCredentialStatus).toBe('[REDACTED]')
		expect(structured.tenant).toMatch(/^hash:/u)
		expect(structured.workspace).toMatch(/^hash:/u)
		expect(structured.session).toMatch(/^hash:/u)
		expect(structured.author).toBe('safe-author')
		expect(Object.values(structured)).toContain('safe-accounting')

		const tags = sanitizeSentryTags({
			auth: 'short-auth-value',
			billingPhone: '5551234',
			contactEmail: 'person-at-example',
			actorUserId: 'user-123',
			safe: 'value'
		})
		expect(tags.billingPhone).toMatch(/^pii:/u)
		expect(tags).not.toHaveProperty('auth')
		expect(tags.contactEmail).toMatch(/^pii:/u)
		expect(tags.actorUserId).toMatch(/^id:/u)
		expect(tags.safe).toBe('value')
		expect(JSON.stringify(tags)).not.toContain('5551234')
		expect(JSON.stringify(tags)).not.toContain('person-at-example')
		expect(JSON.stringify(tags)).not.toContain('user-123')

		const extra = sanitizeSentryExtra({
			billingPhone: '5551234', contactEmail: 'person-at-example', actorUserId: 'user-123'
		})
		const serialized = JSON.stringify(extra)
		expect(serialized).not.toContain('5551234')
		expect(serialized).not.toContain('person-at-example')
		expect(serialized).not.toContain('user-123')
	})

	it('redacts exact auth assignments without treating author as a credential field', () => {
		const redacted = String(redactErrorValue(
			'auth=short-secret serviceAuth=second-secret author=safe-author'
		))

		expect(redacted).toContain('auth=[REDACTED]')
		expect(redacted).toContain('serviceAuth=[REDACTED]')
		expect(redacted).toContain('author=safe-author')
		expect(redacted).not.toContain('short-secret')
		expect(redacted).not.toContain('second-secret')
		expect(redactErrorValue({serviceAuth: 'third-secret', author: 'safe-author'})).toEqual({
			serviceAuth: '[REDACTED]', author: 'safe-author'
		})
		expect(sanitizeSentryTags({serviceAuth: 'fourth-secret', author: 'safe-author'})).toEqual({
			author: 'safe-author'
		})
	})

	it('redacts scheme-less URLs even when they do not contain query parameters', () => {
		for (const value of [
			'visit tenant.example.com/private/customer-record',
			'visit www.example.org/private',
			'connect 192.168.1.20/private/path',
			'email person@example.com after the URL'
		]) {
			const serialized = JSON.stringify(redactErrorValue(value))
			expect(serialized).not.toContain('customer-record')
			expect(serialized).not.toContain('www.example.org')
			expect(serialized).not.toContain('192.168.1.20')
			expect(serialized).not.toContain('person@example.com')
		}
	})

	it('does not let low-cardinality Sentry tags bypass sensitive-value redaction', () => {
		const values = {
			environment: 'sk_live_abcdefghijklmnop',
			release: 'tenant.example.com/private/release',
			category: 'NETWORK',
			severity: 'error'
		}
		const tags = sanitizeSentryTags(values)
		const serialized = JSON.stringify(tags)
		expect(serialized).not.toContain(values.environment)
		expect(serialized).not.toContain(values.release)
		expect(tags.category).toBe('NETWORK')
		expect(tags.severity).toBe('error')
	})

	it('never closes a sink concurrently with a timed-out finalization flush', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const flush = vi.fn(async() => { await gate })
		const close = vi.fn(async() => {})
		const runtime = createReportRuntime({
			sink: {capture: vi.fn(async() => {}), flush, close},
			flushTimeoutMs: 5, shutdownTimeoutMs: 20
		})

		await expect(runtime.shutdown()).rejects.toThrow('Errors shutdown failed.')
		expect(close).not.toHaveBeenCalled()
		release()
		await runtime.shutdown()
		expect(flush).toHaveBeenCalledOnce()
		expect(close).toHaveBeenCalledOnce()
	})

	it('does not reopen captures while a timed-out shutdown flush is still physical', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const capture = vi.fn(async() => {})
		const close = vi.fn(async() => {})
		const runtime = createReportRuntime({
			sink: {capture, flush: vi.fn(async() => { await gate }), close},
			flushTimeoutMs: 50, shutdownTimeoutMs: 5
		})

		await expect(runtime.shutdown()).rejects.toMatchObject({stage: 'shutdown'})
		await expect(runtime.report(baseError('E_UNKNOWN'))).resolves.toBeUndefined()
		expect(capture).not.toHaveBeenCalled()
		release()
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
		await runtime.shutdown()
	})

	it('retains ownership of timed-out physical reports during flush and shutdown', async() => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const close = vi.fn(async() => {})
		const runtime = createReportRuntime({
			baseReport: vi.fn(async() => { await gate }),
			sink: {capture: vi.fn(async() => {}), close},
			reportTimeoutMs: 5, flushTimeoutMs: 5, shutdownTimeoutMs: 10
		})

		await expect(runtime.report(baseError('E_UNKNOWN'))).rejects.toMatchObject({stage: 'report'})
		await expect(runtime.flush()).rejects.toMatchObject({stage: 'flush'})
		await expect(runtime.shutdown()).rejects.toMatchObject({stage: 'shutdown'})
		expect(close).not.toHaveBeenCalled()
		release()
		await runtime.shutdown()
		expect(close).toHaveBeenCalledOnce()
	})

	it('guards public normalize and classify against hostile descriptor re-entry', async() => {
		const observe = vi.fn()
		const handler = createErrorHandler({clock: createFixedClock(1), observe})
		const normalizedReentries: EnrichedError[] = []
		let normalizing = false
		let hostileError!: Error
		hostileError = new Proxy(new Error('hostile normalize'), {
			getOwnPropertyDescriptor(current, key) {
				if (key === 'message' && !normalizing) {
					normalizing = true
					normalizedReentries.push(handler.normalize(hostileError) as EnrichedError)
				}
				return Reflect.getOwnPropertyDescriptor(current, key)
			}
		})

		const normalized = handler.normalize(hostileError) as EnrichedError
		expect(normalized.message).toBe('hostile normalize')
		expect(normalizedReentries).toEqual([
			expect.objectContaining({message: 'Errors handler capacity exceeded.'})
		])

		const classifiedReentries: EnrichedError[] = []
		let classifying = false
		let hostileEnriched!: EnrichedError
		hostileEnriched = new Proxy(baseError('E_HOSTILE_CLASSIFY'), {
			getOwnPropertyDescriptor(current, key) {
				if (key === 'kind' && !classifying) {
					classifying = true
					classifiedReentries.push(handler.classify(hostileEnriched) as EnrichedError)
				}
				return Reflect.getOwnPropertyDescriptor(current, key)
			}
		})

		const classified = handler.classify(hostileEnriched) as EnrichedError
		expect(classified.code).toBe('E_HOSTILE_CLASSIFY')
		expect(classifiedReentries).toEqual([
			expect.objectContaining({message: 'Errors handler capacity exceeded.'})
		])
		expect(observe).toHaveBeenCalledWith(
			'error:reporter', expect.objectContaining({reason: 'handler_transform_reentrancy'})
		)
		await handler.shutdown()
	})
})
