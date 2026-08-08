import {randomUUID} from 'node:crypto'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {createPostgresEventMigrations} from '../../src/events/migrations/postgres'
import {createProductionEvents} from '../../src/events/public/production'
import {createPostgresEventsBackend} from '../../src/events/stores/postgres'

const connectionString = process.env.OOOPS_TEST_POSTGRES_URL
const run = connectionString ? describe : describe.skip

run('events PostgreSQL integration', () => {
	let pool: import('pg').Pool
	const prefix = `events_${randomUUID().replaceAll('-', '').slice(0, 16)}`

	beforeAll(async() => {
		const {Pool} = await import('pg')
		pool = new Pool({connectionString, max: 2})
		for (const migration of createPostgresEventMigrations(prefix)) await pool.query(migration.sql)
	})

	afterAll(async() => {
		if (!pool) return
		await pool.query(`DROP TABLE IF EXISTS ${prefix}_inbox`)
		await pool.query(`DROP TABLE IF EXISTS ${prefix}_outbox`)
		await pool.end()
	})

	it('publishes through a verified durable outbox', async() => {
		const runtime = await createProductionEvents({
			backend: createPostgresEventsBackend({client: pool, tablePrefix: prefix}),
			role: 'publisher'
		})
		runtime.events.registerDefinition({
			type: 'integration.created',
			source: 'events-integration',
			schema: {parse: (value) => value as {id: string}}
		})
		await runtime.events.start()
		const event = await runtime.events.publish('integration.created', {id: 'one'})
		const rows = await runtime.admin!.listOutbox({type: 'integration.created'})
		expect(rows).toEqual([expect.objectContaining({eventId: event.id, type: 'integration.created'})])
		await runtime.events.shutdown()
	})

	it('round-trips an already-normalized payload without parsing it twice', async() => {
		let resolveConsumed!: (payload: unknown) => void
		const consumed = new Promise<unknown>((resolve) => { resolveConsumed = resolve })
		const parse = (value: unknown): {normalized: string} => {
			if (typeof value !== 'string') throw new Error('schema accepts only source strings')
			return {normalized: value}
		}
		const runtime = await createProductionEvents({
			backend: createPostgresEventsBackend({client: pool, tablePrefix: prefix}),
			role: 'combined'
		})
		runtime.events.registerDefinition({type: 'integration.transformed', source: 'events-integration', schema: {parse}})
		runtime.events.registerConsumer({name: 'integration-transform-consumer', eventTypes: ['integration.transformed']}, async(event) => {
			resolveConsumed(event.payload)
		})
		await runtime.events.start()
		const published = await runtime.events.publish('integration.transformed', 'source')
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const delivered = await Promise.race([
				consumed,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('integration transform timeout')), 2_000) })
			])
			expect(published.payload).toEqual({normalized: 'source'})
			expect(delivered).toEqual({normalized: 'source'})
		} finally {
			if (timer) clearTimeout(timer)
			await runtime.events.shutdown()
		}
	})

	it('fences expiration purge behind an active dispatch lease', async() => {
		const backend = createPostgresEventsBackend({client: pool, tablePrefix: prefix})
		await backend.outbox.append([{
			envelope: {
				id: 'leased-expiring-event', type: 'integration.expiring', specVersion: '1.0', source: 'events-integration',
				occurredAt: new Date(0).toISOString(), expiresAt: new Date(10).toISOString(), headers: {}, payload: {}
			},
			status: 'queued', attempts: 0, availableAt: 0, expiresAt: 10, createdAt: 0, updatedAt: 0
		}])
		const [claimed] = await backend.outbox.claimDue({now: 5, limit: 1, owner: 'integration-worker', leaseMs: 100})
		expect(claimed?.lease?.expiresAt).toBe(105)
		await expect(backend.outbox.purgeExpired(11, 1)).resolves.toBe(0)
		await expect(backend.outbox.complete(
			'leased-expiring-event',
			'integration-worker',
			claimed!.lease!.generation
		)).resolves.toBe(true)
	})

	it('never claims and can purge an event that expired before the Unix epoch', async() => {
		const backend = createPostgresEventsBackend({client: pool, tablePrefix: prefix})
		await backend.outbox.append([{
			envelope: {
				id: 'pre-epoch-expired-event', type: 'integration.expired', specVersion: '1.0', source: 'events-integration',
				occurredAt: new Date(-2).toISOString(), expiresAt: new Date(-1).toISOString(), headers: {}, payload: {}
			},
			status: 'queued', attempts: 0, availableAt: -2, expiresAt: -1, createdAt: -2, updatedAt: -2
		}])
		await expect(backend.outbox.claimDue({now: 0, limit: 1, owner: 'integration-worker', leaseMs: 100})).resolves.toEqual([])
		await expect(backend.outbox.purgeExpired(0, 1)).resolves.toBe(1)
	})

	it('reclaims a dispatching row whose lease timestamp is missing', async() => {
		await pool.query(`TRUNCATE ${prefix}_inbox, ${prefix}_outbox`)
		const backend = createPostgresEventsBackend({client: pool, tablePrefix: prefix})
		await backend.outbox.append([{
			envelope: {
				id: 'missing-lease-event', type: 'integration.recovery', specVersion: '1.0', source: 'events-integration',
				occurredAt: new Date(0).toISOString(), headers: {}, payload: {}
			},
			status: 'queued', attempts: 0, availableAt: 0, createdAt: 0, updatedAt: 0
		}])
		await pool.query(`UPDATE ${prefix}_outbox SET status='dispatching',processing_started_at=NULL,processing_by=NULL WHERE event_id=$1`, ['missing-lease-event'])
		const [claimed] = await backend.outbox.claimDue({now: 1, limit: 1, owner: 'recovery-worker', leaseMs: 100})
		expect(claimed).toMatchObject({
			envelope: {id: 'missing-lease-event'},
			status: 'dispatching', attempts: 1,
			lease: {owner: 'recovery-worker', expiresAt: 101, generation: 1}
		})
	})

	it('dead-letters a malformed saturated durable row instead of poisoning its claim batch', async() => {
		await pool.query(`TRUNCATE ${prefix}_inbox, ${prefix}_outbox`)
		await pool.query(`INSERT INTO ${prefix}_outbox
			(event_id,envelope_json,status,attempts,next_attempt_at,created_at,updated_at,attempts_log_json)
			VALUES ($1,'[]'::jsonb,'queued',2147483647,now(),now(),now(),'[]'::jsonb)`, ['malformed-durable-row'])
		const runtime = await createProductionEvents({
			backend: createPostgresEventsBackend({client: pool, tablePrefix: prefix}),
			role: 'worker'
		})
		try {
			await runtime.events.start()
			await expect(runtime.admin!.listDeadLetters()).resolves.toEqual([
				expect.objectContaining({eventId: 'malformed-durable-row', attempts: 1_000_000})
			])
		} finally { await runtime.events.shutdown() }
	})

	it('self-heals a malformed inbox lease and delivers the event', async() => {
		await pool.query(`TRUNCATE ${prefix}_inbox, ${prefix}_outbox`)
		const backend = createPostgresEventsBackend({client: pool, tablePrefix: prefix})
		await backend.outbox.append([{
			envelope: {
				id: 'malformed-inbox-event', type: 'integration.inbox-recovery', specVersion: '1.0', source: 'events-integration',
				occurredAt: new Date().toISOString(), headers: {}, payload: {}
			},
			status: 'queued', attempts: 0, availableAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now()
		}])
		await pool.query(`INSERT INTO ${prefix}_inbox(consumer,event_id,record_json) VALUES ($1,$2,$3::jsonb)`, [
			'inbox-recovery-consumer', 'malformed-inbox-event', JSON.stringify({owner: 42, expiresAt: 'invalid', complete: 'invalid'})
		])
		const consumed: string[] = []
		const runtime = await createProductionEvents({backend, role: 'worker'})
		runtime.events.registerDefinition({
			type: 'integration.inbox-recovery', source: 'events-integration', schema: {parse: (value) => value as object}
		})
		runtime.events.registerConsumer({
			name: 'inbox-recovery-consumer', eventTypes: ['integration.inbox-recovery']
		}, async(event) => { consumed.push(event.id) })
		try {
			await runtime.events.start()
			expect(consumed).toEqual(['malformed-inbox-event'])
			await expect(runtime.admin!.listOutbox({type: 'integration.inbox-recovery'})).resolves.toEqual([
				expect.objectContaining({eventId: 'malformed-inbox-event', status: 'dispatched'})
			])
		} finally { await runtime.events.shutdown() }
	})

	it('delivers through the real PostgreSQL worker lease and inbox pipeline', async() => {
		let resolveConsumed!: () => void
		const consumed = new Promise<void>((resolve) => { resolveConsumed = resolve })
		const runtime = await createProductionEvents({
			backend: createPostgresEventsBackend({client: pool, tablePrefix: prefix}),
			role: 'combined'
		})
		runtime.events.registerDefinition({
			type: 'integration.consumed', source: 'events-integration',
			schema: {parse: (value) => value as {id: string}}
		})
		runtime.events.registerConsumer({name: 'integration-consumer', eventTypes: ['integration.consumed']}, async() => {
			resolveConsumed()
		})
		await runtime.events.start()
		const event = await runtime.events.publish('integration.consumed', {id: 'worker'})
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				consumed,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('integration delivery timeout')), 2_000) })
			])
		} catch(error) {
			const diagnostics = {status: runtime.events.getStatus(), rows: await runtime.admin!.listOutbox({limit: 10})}
			await runtime.events.shutdown().catch(() => undefined)
			throw new AggregateError([error], JSON.stringify(diagnostics))
		} finally { if (timer) clearTimeout(timer) }
		await runtime.events.flush()
		await expect(runtime.admin!.listOutbox({type: 'integration.consumed'})).resolves.toEqual([
			expect.objectContaining({eventId: event.id, status: 'dispatched'})
		])
		await runtime.events.shutdown()
	})

	it('releases a failed inbox claim and completes a PostgreSQL retry', async() => {
		let attempts = 0
		let resolveRetried!: () => void
		const retried = new Promise<void>((resolve) => { resolveRetried = resolve })
		const runtime = await createProductionEvents({
			backend: createPostgresEventsBackend({client: pool, tablePrefix: prefix}),
			role: 'combined'
		})
		runtime.events.registerDefinition({
			type: 'integration.retry', source: 'events-integration',
			schema: {parse: (value) => value as {id: string}}
		})
		runtime.events.registerConsumer({name: 'integration-retry-consumer', eventTypes: ['integration.retry']}, async() => {
			attempts++
			if (attempts === 1) throw new Error('first attempt fails')
			resolveRetried()
		})
		await runtime.events.start()
		const event = await runtime.events.publish('integration.retry', {id: 'retry'})
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				retried,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('integration retry timeout')), 3_000) })
			])
		} catch(error) {
			const diagnostics = {status: runtime.events.getStatus(), rows: await runtime.admin!.listOutbox({limit: 10})}
			await runtime.events.shutdown().catch(() => undefined)
			throw new AggregateError([error], JSON.stringify(diagnostics))
		} finally { if (timer) clearTimeout(timer) }
		await runtime.events.flush()
		await expect(runtime.admin!.listOutbox({type: 'integration.retry'})).resolves.toEqual([
			expect.objectContaining({eventId: event.id, status: 'dispatched', attempts: 2})
		])
		await runtime.events.shutdown()
	})

	it('keeps transactional publication inside the real PostgreSQL transaction', async() => {
		const runtime = await createProductionEvents({
			backend: createPostgresEventsBackend({client: pool, tablePrefix: prefix}),
			role: 'publisher'
		})
		runtime.events.registerDefinition({
			type: 'integration.transactional', source: 'events-integration',
			schema: {parse: (value) => value as {id: string}}
		})
		await runtime.events.start()
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await runtime.transactional!.publishTransactional(client, 'integration.transactional', {id: 'rolled-back'})
			await client.query('ROLLBACK')
			await expect(runtime.admin!.listOutbox({type: 'integration.transactional'})).resolves.toEqual([])

			await client.query('BEGIN')
			const committed = await runtime.transactional!.publishTransactional(client, 'integration.transactional', {id: 'committed'})
			await client.query('COMMIT')
			await expect(runtime.admin!.listOutbox({type: 'integration.transactional'})).resolves.toEqual([
				expect.objectContaining({eventId: committed.id, status: 'queued'})
			])
		} finally {
			await client.query('ROLLBACK').catch(() => undefined)
			client.release()
			await runtime.events.shutdown()
		}
	})
})
