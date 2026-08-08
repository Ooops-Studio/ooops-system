import type {PerformanceEventRecord} from '@ooopsstudio/core/contracts/performance'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it, vi} from 'vitest'

import {createCustomPerformance} from '../../src/performance/public/custom'

describe('performance measurement correctness', () => {
	it('records every retained measurement shape and runs business callbacks exactly once', async() => {
		const records: PerformanceEventRecord[] = []
		const performance = await createCustomPerformance({
			clock: createFixedClock(100),
			destinations: [{name: 'recording', exporter: {async export(batch) { records.push(...batch) }}}],
			delivery: {flushIntervalMs: 0}
		})
		const sync = vi.fn(() => 'sync')
		const asyncWork = vi.fn(async() => 'async')
		const dbSync = vi.fn(() => 1)
		const dbAsync = vi.fn(async() => 2)
		const request = vi.fn(async() => new Response(null, {status: 201}))
		const span = vi.fn(async() => 'span')

		expect(performance.measureSync('sync.operation', sync)).toBe('sync')
		await expect(performance.measureAsync('async.operation', asyncWork)).resolves.toBe('async')
		expect(performance.measureDBQuerySync('db.sync', dbSync, {operation: 'select'})).toBe(1)
		await expect(performance.measureDBQuery('db.async', dbAsync, {operation: 'select'})).resolves.toBe(2)
		await expect(performance.measureRequest(
			'http.request', request, {method: 'get', route: '/documents/123456'}
		)).resolves.toHaveProperty('status', 201)
		await expect(performance.measureSpan('span.operation', span)).resolves.toBe('span')
		for (const callback of [sync, asyncWork, dbSync, dbAsync, request, span]) expect(callback).toHaveBeenCalledOnce()

		await performance.flush()
		expect(records.map(({event}) => event.name)).toEqual([
			'sync.operation', 'async.operation', 'db.sync', 'db.async', 'http.request', 'span.operation'
		])
		expect(records.find(({event}) => event.name === 'http.request')?.event.http).toMatchObject({
			method: 'GET', route: '/documents/:id', statusCode: 201, outcome: 'ok'
		})
		await performance.shutdown()
	})

	it('preserves thrown business errors while dropping hostile labels safely', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(100)})
		let getterCalls = 0
		const labels = Object.defineProperty({}, 'secret', {
			enumerable: true,
			get() { getterCalls += 1; return 'never-read' }
		})
		const failure = new Error('business failure')
		const operation = vi.fn(async() => { throw failure })
		await expect(performance.measureAsync('hostile.labels', operation, labels as never)).rejects.toBe(failure)
		expect(operation).toHaveBeenCalledOnce()
		expect(getterCalls).toBe(0)
		expect(performance.getStatus().droppedTotal).toBe(1)
		await performance.shutdown()
	})

	it('does not let a stale success status mask a thrown request failure', async() => {
		const records: PerformanceEventRecord[] = []
		const performance = await createCustomPerformance({
			clock: createFixedClock(100),
			destinations: [{name: 'recording', exporter: {async export(batch) { records.push(...batch) }}}],
			delivery: {flushIntervalMs: 0}
		})
		const failure = new Error('request failed after status assignment')
		await expect(performance.measureRequest(
			'http.failed', async() => { throw failure },
			{method: 'GET', route: '/documents', statusCode: 200}
		)).rejects.toBe(failure)
		await expect(performance.measureSpan(
			'http.span.failed', async() => { throw failure },
			{http: {method: 'GET', route: '/spans', statusCode: 200}}
		)).rejects.toBe(failure)
		await performance.flush()

		expect(records).toHaveLength(2)
		expect(records[0]?.event).toMatchObject({
			outcome: 'server_error',
			http: {method: 'GET', route: '/documents', outcome: 'server_error'}
		})
		expect(records[0]?.event.http).not.toHaveProperty('statusCode')
		expect(records[1]?.event).toMatchObject({
			outcome: 'server_error',
			http: {method: 'GET', route: '/spans', outcome: 'server_error'},
			labels: {outcome: 'server_error', instrumentation: 'span'}
		})
		expect(records[1]?.event.http).not.toHaveProperty('statusCode')
		await performance.shutdown()
	})

	it('does not execute DB metadata array accessors before business work', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(100)})
		const readOrder = vi.fn(() => 'secret')
		const orderBy: unknown[] = []
		Object.defineProperty(orderBy, '0', {enumerable: true, get: readOrder})
		Object.defineProperty(orderBy, 'length', {value: 1})
		const operation = vi.fn(async() => 'ok')

		await expect(performance.measureDBQuery(
			'db.safe', operation, {operation: 'select', orderBy: orderBy as never}
		)).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledOnce()
		expect(readOrder).not.toHaveBeenCalled()

		const metadataDescriptor = vi.fn(() => ({configurable: true, enumerable: true, value: 'select'}))
		const proxyMetadata = new Proxy({}, {getOwnPropertyDescriptor: metadataDescriptor})
		await expect(performance.measureDBQuery(
			'db.safe-proxy', operation, proxyMetadata as never
		)).resolves.toBe('ok')
		expect(metadataDescriptor).not.toHaveBeenCalled()
		expect(operation).toHaveBeenCalledTimes(2)
		await performance.shutdown()
	})

	it('does not invoke HTTP metadata Proxy traps before business work', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(100)})
		const metadataDescriptor = vi.fn(() => ({configurable: true, enumerable: true, value: 'GET'}))
		const metadata = new Proxy({}, {getOwnPropertyDescriptor: metadataDescriptor})
		const operation = vi.fn(async() => ({status: 200}))

		await expect(performance.measureRequest(
			'http.safe-metadata-proxy', operation, metadata as never
		)).resolves.toEqual({status: 200})
		expect(operation).toHaveBeenCalledOnce()
		expect(metadataDescriptor).not.toHaveBeenCalled()
		await performance.shutdown()
	})

	it('does not execute response status accessors or proxy traps after business work', async() => {
		const performance = await createCustomPerformance({clock: createFixedClock(100)})
		const readStatus = vi.fn(() => 200)
		const accessorResult = Object.defineProperty({}, 'status', {enumerable: true, get: readStatus})
		const accessorOperation = vi.fn(async() => accessorResult)
		await expect(performance.measureRequest(
			'http.safe-accessor', accessorOperation, {method: 'GET', route: '/safe'}
		)).resolves.toBe(accessorResult)

		const has = vi.fn(() => true)
		const descriptor = vi.fn(() => ({configurable: true, enumerable: true, value: 200}))
		const proxyResult = new Proxy({}, {has, getOwnPropertyDescriptor: descriptor})
		const proxyOperation = vi.fn(async() => proxyResult)
		await expect(performance.measureRequest(
			'http.safe-proxy', proxyOperation, {method: 'GET', route: '/safe'}
		)).resolves.toBe(proxyResult)

		expect(accessorOperation).toHaveBeenCalledOnce()
		expect(proxyOperation).toHaveBeenCalledOnce()
		expect(readStatus).not.toHaveBeenCalled()
		expect(has).not.toHaveBeenCalled()
		expect(descriptor).not.toHaveBeenCalled()
		const inheritedTrap = vi.fn(() => { throw new Error('prototype trap') })
		const inheritedProxyResult = Object.create(new Proxy({}, {getPrototypeOf: inheritedTrap}))
		const returnedInheritedProxy = await performance.measureRequest(
			'http.safe-inherited-proxy', async() => inheritedProxyResult, {method: 'GET', route: '/safe'}
		)
		expect(inheritedTrap).not.toHaveBeenCalled()
		expect(returnedInheritedProxy).toBe(inheritedProxyResult)

		const readSubclassStatus = vi.fn(() => 500)
		class HostileResponse extends Response {
			override get status(): number { return readSubclassStatus() }
		}
		const subclassResult = new HostileResponse(null, {status: 202})
		await expect(performance.measureRequest(
			'http.safe-response-subclass', async() => subclassResult, {method: 'GET', route: '/safe'}
		)).resolves.toBe(subclassResult)
		expect(readSubclassStatus).not.toHaveBeenCalled()
		await performance.shutdown()
	})
})
