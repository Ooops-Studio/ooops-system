import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

import {Pool} from 'pg'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {buildAuditIntegrity} from '../../../src/audit/core/integrity'
import {normalizeAuditWriteRequest} from '../../../src/audit/core/write-normalization'
import {createPostgresAuditStore} from '../../../src/audit/features/stores/postgres-store'
import {createProductionAudit} from '../../../src/audit/public/production'

const connectionString = process.env.AUDIT_POSTGRES_URL
const migrationPath = process.env.AUDIT_POSTGRES_MIGRATION_PATH
	?? fileURLToPath(new URL('../fixtures/audit-schema.sql', import.meta.url))
const describeLive = connectionString ? describe : describe.skip

describeLive('audit PostgreSQL live integration', () => {
	const pool = new Pool({connectionString})
	const prefix = `al_${randomUUID().replaceAll('-', '').slice(0, 20)}`
	const store = createPostgresAuditStore({client: pool, tablePrefix: prefix})
	const now = Date.parse('2024-01-01T00:00:00.000Z')
	const clock = {now: () => now}
	const prepared = (id: string, idempotencyKey?: string, stream = 'main') => normalizeAuditWriteRequest(clock, {
		id,
		...(idempotencyKey ? {idempotencyKey} : {}),
		eventType: 'audit.live',
		category: 'audit',
		action: 'record',
		actor: {kind: 'service'},
		target: {entityType: 'record', entityId: id},
		outcome: 'succeeded',
		sensitivity: 'high',
		tenantId: 'tenant-live',
		stream
	})

	beforeAll(async() => {
		const migration = await readFile(migrationPath!, 'utf8')
		const isolatedMigration = migration.replaceAll('"audit_', `"${prefix}_`)
		for (const statement of isolatedMigration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
			await pool.query(statement)
		}
		await store.verifyCompatibility()
	})
	afterAll(async() => {
		await pool.query(`DROP TABLE IF EXISTS ${prefix}_records, ${prefix}_chain_heads, ${prefix}_schema_migrations, ${prefix}_record_tombstones CASCADE`)
		await pool.end()
	})

	it('constructs the production transactional runtime only after pool verification', async() => {
		const runtime = await createProductionAudit({postgres: {client: pool, tablePrefix: prefix}, clock})
		expect(runtime.transactional).toBeDefined()
		await runtime.audit.shutdown()
	})

	it('upgrades synchronous_commit=off inside caller-owned audit transactions', async() => {
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await client.query('SET LOCAL synchronous_commit=off')
			const inserted = await store.appendTransactional(client, [prepared('durable-transaction-live', undefined, 'durable')])
			const setting = await client.query<{synchronous_commit: string}>('SHOW synchronous_commit')
			expect(setting.rows[0]?.synchronous_commit).toBe('on')
			await client.query('COMMIT')
			await pool.query(`DELETE FROM ${prefix}_records WHERE id=$1`, [inserted[0]!.record.id])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key=$1`, [inserted[0]!.record.integrity.partitionKey])
		} catch(error) {
			await client.query('ROLLBACK')
			throw error
		} finally {
			client.release()
		}
	})

	it('does not let caller search_path functions bypass transactional durability', async() => {
		const schema = `${prefix}_shadow`
		await pool.query(`CREATE SCHEMA ${schema}`)
		await pool.query(`CREATE FUNCTION ${schema}.current_setting(text) RETURNS text
			LANGUAGE sql IMMUTABLE AS 'SELECT ''on''::text'`)
		await pool.query(`CREATE FUNCTION ${schema}.set_config(text,text,boolean) RETURNS text
			LANGUAGE sql VOLATILE AS 'SELECT $2'`)
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await client.query(`SET LOCAL search_path=${schema},pg_catalog`)
			await client.query('SET LOCAL synchronous_commit=off')
			await expect(store.appendTransactional(client, [
				prepared('shadow-durability-live', undefined, 'shadow-durability')
			])).rejects.toThrow(/PostgreSQL identity differs/)
			expect((await client.query<{synchronous_commit: string}>('SHOW synchronous_commit')).rows[0]?.synchronous_commit)
				.toBe('off')
			expect(await store.getById('shadow-durability-live')).toBeUndefined()
			await client.query('ROLLBACK')
			await client.query('BEGIN')
			await client.query(`SET LOCAL search_path=${schema}`)
			await client.query('SET LOCAL synchronous_commit=off')
			await expect(store.appendTransactional(client, [
				prepared('shadow-durability-live', undefined, 'shadow-durability')
			])).resolves.toMatchObject([{inserted: true}])
			expect((await client.query<{synchronous_commit: string}>('SHOW synchronous_commit')).rows[0]?.synchronous_commit)
				.toBe('on')
			await client.query('ROLLBACK')
		} finally {
			client.release()
			await pool.query(`DROP SCHEMA ${schema} CASCADE`)
		}
	})

	it('does not let session search_path functions intercept audit reads', async() => {
		const schema = `${prefix}_read_shadow`
		const inserted = await store.appendMany([prepared('shadow-read-live', undefined, 'shadow-read')])
		const readPool = new Pool({connectionString, max: 1})
		const readStore = createPostgresAuditStore({client: readPool, tablePrefix: prefix})
		try {
			await readStore.verifyCompatibility()
			await readPool.query(`CREATE SCHEMA ${schema}`)
			await readPool.query(`CREATE FUNCTION ${schema}.octet_length(text) RETURNS integer
				LANGUAGE sql IMMUTABLE AS 'SELECT 1000000'`)
			await readPool.query(`SET search_path=${schema},pg_catalog`)
			await expect(readStore.getById(inserted[0]!.record.id)).resolves.toMatchObject({id: inserted[0]!.record.id})
			await expect(readStore.query({partitionKey: inserted[0]!.record.integrity.partitionKey}))
				.resolves.toMatchObject({items: [{id: inserted[0]!.record.id}]})
		} finally {
			await readPool.query('RESET search_path')
			await readPool.query(`DROP SCHEMA ${schema} CASCADE`)
			await readPool.end()
			await pool.query(`DELETE FROM ${prefix}_records WHERE id=$1`, [inserted[0]!.record.id])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key=$1`, [inserted[0]!.record.integrity.partitionKey])
		}
	})

	it('keeps temporary types behind pg_catalog and rejects unsafe caller temp precedence', async() => {
		const tempPool = new Pool({connectionString, max: 1})
		const tempStore = createPostgresAuditStore({client: tempPool, tablePrefix: prefix})
		let insertedId: string | undefined
		try {
			await tempStore.verifyCompatibility()
			await tempPool.query('CREATE TEMP TABLE initialize_audit_temp_schema(value integer)')
			await tempPool.query('CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (false)')
			const inserted = await tempStore.appendMany([prepared('temp-type-live', undefined, 'temp-type')])
			insertedId = inserted[0]!.record.id
			const client = await tempPool.connect()
			try {
				await client.query('BEGIN')
				await expect(store.appendTransactional(client, [prepared('unsafe-temp-caller-live', undefined, 'temp-type')]))
					.rejects.toThrow(/PostgreSQL identity differs/)
				await client.query('ROLLBACK')
			} finally { client.release() }
		} finally {
			await tempPool.end()
			if (insertedId) {
				await pool.query(`DELETE FROM ${prefix}_records WHERE id=$1`, [insertedId])
				await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE last_record_id=$1`, [insertedId])
			}
		}
	})

	it('rolls back a rejected audit batch to a savepoint without aborting the caller transaction', async() => {
		const existing = await store.appendMany([prepared('savepoint-existing-live', undefined, 'savepoint-existing')])
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await expect(store.appendTransactional(client, [
				prepared('savepoint-new-live', undefined, 'savepoint-new'),
				prepared('savepoint-existing-live', undefined, 'savepoint-existing')
			])).rejects.toThrow(/already exists/)
			await expect(client.query('SELECT 1 AS usable')).resolves.toMatchObject({rows: [{usable: 1}]})
			await client.query('COMMIT')
			await expect(store.getById('savepoint-new-live')).resolves.toBeUndefined()
		} catch(error) {
			await client.query('ROLLBACK')
			throw error
		} finally {
			client.release()
			await pool.query(`DELETE FROM ${prefix}_records WHERE id=$1`, [existing[0]!.record.id])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key=$1`, [existing[0]!.record.integrity.partitionKey])
		}
	})

	it('recovers the caller transaction after a PostgreSQL write error inside the audit savepoint', async() => {
		const functionName = `${prefix}_fail_selected_write`
		const triggerName = `${prefix}_fail_selected_write_trigger`
		await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.id = 'savepoint-db-error-live' THEN RAISE EXCEPTION 'forced audit insert failure'; END IF;
				RETURN NEW;
			END
		$$`)
		await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${prefix}_records
			FOR EACH ROW EXECUTE FUNCTION ${functionName}()`)
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await expect(store.appendTransactional(client, [
				prepared('savepoint-db-error-live', undefined, 'savepoint-db-error')
			])).rejects.toThrow(/forced audit insert failure/)
			await expect(client.query('SELECT 1 AS usable')).resolves.toMatchObject({rows: [{usable: 1}]})
			await client.query('COMMIT')
		} catch(error) {
			await client.query('ROLLBACK')
			throw error
		} finally {
			client.release()
			await pool.query(`DROP TRIGGER ${triggerName} ON ${prefix}_records`)
			await pool.query(`DROP FUNCTION ${functionName}()`)
		}
	})

	it('rejects row security and custom write triggers as incompatible schema behavior', async() => {
		await pool.query(`ALTER TABLE ${prefix}_records ENABLE ROW LEVEL SECURITY`)
		try {
			const rlsStore = createPostgresAuditStore({client: pool, tablePrefix: prefix})
			await expect(rlsStore.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		} finally {
			await pool.query(`ALTER TABLE ${prefix}_records DISABLE ROW LEVEL SECURITY`)
		}

		const functionName = `${prefix}_drop_audit_write`
		const triggerName = `${prefix}_drop_audit_write_trigger`
		await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RETURN NULL; END
		$$`)
		await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${prefix}_records
			FOR EACH ROW EXECUTE FUNCTION ${functionName}()`)
		try {
			const triggerStore = createPostgresAuditStore({client: pool, tablePrefix: prefix})
			await expect(triggerStore.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		} finally {
			await pool.query(`DROP TRIGGER ${triggerName} ON ${prefix}_records`)
			await pool.query(`DROP FUNCTION ${functionName}()`)
		}
		const ruleName = `${prefix}_drop_audit_insert`
		await pool.query(`CREATE RULE ${ruleName} AS ON INSERT TO ${prefix}_records DO INSTEAD NOTHING`)
		try {
			const ruleStore = createPostgresAuditStore({client: pool, tablePrefix: prefix})
			await expect(ruleStore.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		} finally {
			await pool.query(`DROP RULE ${ruleName} ON ${prefix}_records`)
		}
	})

	it('rejects unlogged audit evidence tables', async() => {
		await pool.query(`ALTER TABLE ${prefix}_records SET UNLOGGED`)
		try {
			const unloggedStore = createPostgresAuditStore({client: pool, tablePrefix: prefix})
			await expect(unloggedStore.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		} finally {
			await pool.query(`ALTER TABLE ${prefix}_records SET LOGGED`)
		}
	})

	it('rejects inherited child tables that would escape schema verification', async() => {
		const child = `${prefix}_records_child`
		await pool.query(`CREATE TABLE ${child} () INHERITS (${prefix}_records)`)
		try {
			const inheritedStore = createPostgresAuditStore({client: pool, tablePrefix: prefix})
			await expect(inheritedStore.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		} finally {
			await pool.query(`DROP TABLE ${child}`)
		}
	})

	it('reads compatible PostgreSQL tables with additional application columns', async() => {
		await pool.query(`ALTER TABLE ${prefix}_records ADD COLUMN extension_payload jsonb`)
		await pool.query(`ALTER TABLE ${prefix}_chain_heads ADD COLUMN extension_payload text`)
		const inserted = await store.appendMany([prepared('extended-schema-live', undefined, 'extended-schema')])
		const record = inserted[0]!.record
		await pool.query(`UPDATE ${prefix}_records SET extension_payload = jsonb_build_object('payload', repeat('x', 1048577))
			WHERE id = $1`, [record.id])
		await pool.query(`UPDATE ${prefix}_chain_heads SET extension_payload = repeat('x', 1048577)
			WHERE partition_key = $1`, [record.integrity.partitionKey])
		try {
			await expect(store.getById(record.id)).resolves.toEqual(record)
			const next = await store.appendMany([prepared('extended-schema-next', undefined, 'extended-schema')])
			expect(next[0]!.record.integrity.sequence).toBe(2)
			await expect(store.planPruneBefore!('2025-01-01T00:00:00.000Z', 10))
				.resolves.toMatchObject({records: [{id: record.id}, {id: 'extended-schema-next'}]})
		}
		finally {
			await pool.query(`DELETE FROM ${prefix}_records WHERE partition_key = $1`, [record.integrity.partitionKey])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [record.integrity.partitionKey])
		}
	})

	it('rejects additional columns whose defaults add audit-write side effects', async() => {
		const sequence = `${prefix}_unsafe_default`
		await pool.query(`CREATE SEQUENCE ${sequence}`)
		await pool.query(`ALTER TABLE ${prefix}_records ADD COLUMN unsafe_default bigint
			DEFAULT nextval('${sequence}'::regclass)`)
		try {
			const unsafeStore = createPostgresAuditStore({client: pool, tablePrefix: prefix})
			await expect(unsafeStore.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		} finally {
			await pool.query(`ALTER TABLE ${prefix}_records DROP COLUMN unsafe_default`)
			await pool.query(`DROP SEQUENCE ${sequence}`)
		}
	})

	it('rejects additional indexes on every mutable audit table', async() => {
		const index = `${prefix}_unsafe_head_unique`
		await pool.query(`CREATE UNIQUE INDEX ${index} ON ${prefix}_chain_heads(last_sequence)`)
		try {
			const unsafeStore = createPostgresAuditStore({client: pool, tablePrefix: prefix})
			await expect(unsafeStore.verifyCompatibility()).rejects.toMatchObject({code: 'AUDIT_SCHEMA_INCOMPATIBLE'})
		} finally {
			await pool.query(`DROP INDEX ${index}`)
		}
	})

	it('rejects a corrupted oversized row without returning its unbounded payload', async() => {
		const inserted = await store.appendMany([prepared('oversized-row-live', undefined, 'oversized-row')])
		const record = inserted[0]!.record
		await pool.query(`UPDATE ${prefix}_records
			SET metadata_json = jsonb_build_object('payload', repeat('x', 1048577)) WHERE id = $1`, [record.id])
		try {
			await expect(store.getById(record.id)).rejects.toThrow(/unsafe sequence/)
			await expect(store.query({partitionKey: record.integrity.partitionKey})).rejects.toThrow(/unsafe sequence/)
			await expect(store.verifyIntegrity!({partitionKey: record.integrity.partitionKey})).rejects.toThrow(/unsafe sequence/)
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [record.integrity.partitionKey])
			await expect(store.verifyIntegrity!({partitionKey: record.integrity.partitionKey})).rejects.toThrow(/invalid orphan row/)
			await pool.query(`INSERT INTO ${prefix}_chain_heads
				(partition_key,last_sequence,last_hash,last_record_id,updated_at) VALUES ($1,$2,$3,$4,now())`, [
				record.integrity.partitionKey, record.integrity.sequence, record.integrity.hash, record.id
			])
			await pool.query(`UPDATE ${prefix}_chain_heads SET last_record_id = repeat('x', 1048577)
				WHERE partition_key = $1`, [record.integrity.partitionKey])
			await expect(store.verifyIntegrity!({partitionKey: record.integrity.partitionKey})).rejects.toThrow(/invalid chain head/)
			await expect(store.appendMany([prepared('oversized-head-next', undefined, 'oversized-row')]))
				.rejects.toThrow(/partition is sealed/)
		} finally {
			await pool.query(`DELETE FROM ${prefix}_records WHERE id = $1`, [record.id])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [record.integrity.partitionKey])
		}
	})

	it('does not expand oversized target arrays while still failing the filtered query closed', async() => {
		const inserted = await store.appendMany([prepared('oversized-targets-live', undefined, 'oversized-targets')])
		const record = inserted[0]!.record
		await pool.query(`UPDATE ${prefix}_records SET targets_json = (
			SELECT jsonb_agg(jsonb_build_object('entityType','record','entityId',value::text))
			FROM generate_series(1, 40000) AS value
		) WHERE id = $1`, [record.id])
		try {
			await expect(store.query({
				partitionKey: record.integrity.partitionKey,
				targetEntityId: 'not-present'
			})).rejects.toThrow(/unsafe sequence/)
		} finally {
			await pool.query(`DELETE FROM ${prefix}_records WHERE id = $1`, [record.id])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [record.integrity.partitionKey])
		}
	})

	it('replays a PostgreSQL idempotency key across deployment resource changes', async() => {
		const write = {
			idempotencyKey: 'live-deployment-retry', eventType: 'audit.live.deployment', category: 'audit', action: 'record',
			actor: {kind: 'service' as const}, target: {entityType: 'record', entityId: 'live-deployment-retry'},
			outcome: 'succeeded' as const, sensitivity: 'high' as const, tenantId: 'tenant-live',
			correlation: {requestId: 'deployment-request'}
		}
		const firstRuntime = await createProductionAudit({
			postgres: {client: pool, tablePrefix: prefix},
			clock: {now: () => Date.parse('2021-01-01T00:00:00.000Z')},
			resource: {serviceName: 'audit-live', serviceVersion: '1.0.0'}
		})
		const first = await firstRuntime.audit.record(write)
		await firstRuntime.audit.shutdown()
		const nextRuntime = await createProductionAudit({
			postgres: {client: pool, tablePrefix: prefix},
			clock: {now: () => Date.parse('2021-01-02T00:00:00.000Z')},
			resource: {serviceName: 'audit-live', serviceVersion: '2.0.0'}
		})
		try {
			await expect(nextRuntime.audit.record(write)).resolves.toEqual(first)
		} finally {
			await nextRuntime.audit.shutdown()
			await pool.query(`DELETE FROM ${prefix}_records WHERE id = $1`, [first.id])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [first.integrity.partitionKey])
		}
	})

	it('persists ordered chains, replays idempotently, queries, verifies, and prunes', async() => {
		const first = await store.appendMany([prepared('first', 'same-command')])
		const replay = await store.appendMany([prepared('first', 'same-command')])
		const second = await store.appendMany([prepared('second')])

		expect(first[0]).toMatchObject({inserted: true, record: {id: 'first', integrity: {sequence: 1, prevHash: null}}})
		expect(replay[0]).toMatchObject({inserted: false, record: {id: 'first'}})
		expect(second[0]).toMatchObject({inserted: true, record: {id: 'second', integrity: {sequence: 2}}})
		expect(second[0]!.record.integrity.prevHash).toBe(first[0]!.record.integrity.hash)
		expect((await store.query({sort: 'asc'})).items.map((record) => record.id)).toEqual(['first', 'second'])
		expect(await store.verifyIntegrity!()).toMatchObject({ok: true, checkedCount: 2})

		const plan = await store.planPruneBefore!('2025-01-01T00:00:00.000Z', 10)
		expect(plan.records).toHaveLength(2)
		expect(await store.prunePlanned!(plan)).toEqual({deletedCount: 2})
		expect((await store.query()).items).toEqual([])
		expect(await store.verifyIntegrity!({partitionKey: first[0]!.record.integrity.partitionKey}))
			.toMatchObject({ok: true, checkedCount: 0})
		await expect(store.appendMany([prepared('first', 'same-command')])).rejects.toThrow(/pruned record/)
		await expect(store.appendMany([prepared('late-after-prune')])).rejects.toThrow(/partition is sealed/)
		await expect(store.appendMany([prepared('first', undefined, 'different-partition')])).rejects.toThrow(/id belongs to a pruned record/)
	})

	it('refuses to extend a chain whose persisted head no longer matches its record', async() => {
		const first = await store.appendMany([prepared('head-base', undefined, 'corrupt-head')])
		await pool.query(`UPDATE ${prefix}_chain_heads SET last_hash = $1 WHERE partition_key = $2`, [
			'f'.repeat(64),
			first[0]!.record.integrity.partitionKey
		])

		await expect(store.appendMany([prepared('head-next', undefined, 'corrupt-head')])).rejects.toThrow(/chain head/)
		expect(await store.getById('head-next')).toBeUndefined()
	})

	it('detects a surviving partition whose chain head was deleted', async() => {
		const inserted = await store.appendMany([prepared('orphan-live', undefined, 'orphan-head')])
		const record = inserted[0]!.record
		await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [record.integrity.partitionKey])

		expect(await store.verifyIntegrity!({partitionKey: record.integrity.partitionKey})).toMatchObject({
			ok: false,
			checkedCount: 0,
			partitionKey: record.integrity.partitionKey,
			brokenAtRecordId: record.id,
			brokenAtSequence: 1
		})
	})

	it('detects a fully deleted active partition through a time-scoped verification', async() => {
		const value = normalizeAuditWriteRequest({now: () => Date.parse('2019-04-05T12:00:00.000Z')}, {
			id: 'empty-active-partition-live', eventType: 'audit.live', category: 'audit', action: 'record',
			actor: {kind: 'service'}, target: {entityType: 'record', entityId: 'empty-active-partition-live'},
			outcome: 'succeeded', sensitivity: 'high', tenantId: 'tenant-live', stream: 'empty-active-partition'
		} as never)
		const inserted = await store.appendMany([value])
		const record = inserted[0]!.record
		await pool.query(`DELETE FROM ${prefix}_records WHERE id = $1`, [record.id])
		try {
			expect(await store.verifyIntegrity!({
				from: '2019-04-05T00:00:00.000Z', to: '2019-04-05T23:59:59.999Z'
			})).toMatchObject({
				ok: false,
				checkedCount: 0,
				partitionKey: record.integrity.partitionKey,
				brokenAtRecordId: record.id,
				brokenAtSequence: 1
			})
		} finally {
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [record.integrity.partitionKey])
		}
	})

	it('rejects stale prune growth before returning an oversized record set', async() => {
		const value = normalizeAuditWriteRequest({now: () => Date.parse('2018-06-01T00:00:00.000Z')}, {
			id: 'bounded-stale-prune-live', eventType: 'audit.live', category: 'audit', action: 'record',
			actor: {kind: 'service'}, target: {entityType: 'record', entityId: 'bounded-stale-prune-live'},
			outcome: 'succeeded', sensitivity: 'high', tenantId: 'tenant-live', stream: 'bounded-stale-prune'
		} as never)
		const inserted = await store.appendMany([value])
		const partitionKey = inserted[0]!.record.integrity.partitionKey
		const plan = await store.planPruneBefore!('2018-06-02T00:00:00.000Z', 10)
		expect(plan.records.map((record) => record.id)).toEqual([value.id])
		try {
			await pool.query(`INSERT INTO ${prefix}_records (
				id, idempotency_hash, semantic_fingerprint, event_type, category, action, occurred_at, created_at,
				actor_json, targets_json, outcome, sensitivity, summary, workspace_id, tenant_id, stream,
				correlation_json, context_json, metadata_json, change_set_json, partition_key, sequence,
				prev_hash, hash, algorithm
			) SELECT 'bounded-stale-' || n, NULL, NULL, 'audit.live', 'audit', 'record',
				'2018-06-01T00:00:00.000Z'::timestamptz, '2018-06-01T00:00:00.000Z'::timestamptz,
				'{"kind":"service"}'::jsonb, '[{"entityType":"record","entityId":"bulk"}]'::jsonb,
				'succeeded', 'high', NULL, NULL, 'tenant-live', 'bounded-stale-prune',
				'{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $1, n, repeat('a', 64), repeat('b', 64),
				'sha256-stable-json-v1' FROM generate_series(2, 10001) AS n`, [partitionKey])

			await expect(store.prunePlanned!(plan)).rejects.toThrow(/incomplete prune partition/)
		} finally {
			await pool.query(`DELETE FROM ${prefix}_records WHERE partition_key = $1`, [partitionKey])
			await pool.query(`DELETE FROM ${prefix}_chain_heads WHERE partition_key = $1`, [partitionKey])
		}
	})

	it('serializes concurrent claims on one partition without duplicate sequences', async() => {
		const results = await Promise.all(Array.from({length: 12}, (_, index) =>
			store.appendMany([prepared(`concurrent-${index}`, undefined, 'concurrent')])
		))
		const records = results.flatMap((result) => result.map((entry) => entry.record))

		expect(new Set(records.map((record) => record.integrity.sequence))).toEqual(new Set(
			Array.from({length: 12}, (_, index) => index + 1)
		))
		expect(await store.verifyIntegrity!({partitionKey: records[0]!.integrity.partitionKey}))
			.toMatchObject({ok: true, checkedCount: 12})
	})

	it('serializes idempotent replay before pruning its durable record', async() => {
		const makeReplay = (instant: string) => normalizeAuditWriteRequest({now: () => Date.parse(instant)}, {
			idempotencyKey: 'replay-prune-command',
			eventType: 'audit.live.replay-prune',
			category: 'audit',
			action: 'record',
			actor: {kind: 'service'},
			target: {entityType: 'record', entityId: 'replay-prune-target'},
			outcome: 'succeeded',
			sensitivity: 'high',
			tenantId: 'tenant-live',
			stream: 'replay-prune'
		} as never)
		const original = await store.appendMany([makeReplay('2020-01-01T00:00:00.000Z')])
		const plan = await store.planPruneBefore!('2020-01-01T12:00:00.000Z', 10)
		expect(plan.records.map((record) => record.id)).toEqual([original[0]!.record.id])

		let releaseReplay!: () => void
		const replayRelease = new Promise<void>((resolve) => { releaseReplay = resolve })
		let markReplayRead!: () => void
		const replayRead = new Promise<void>((resolve) => { markReplayRead = resolve })
		let shouldPause = true
		const replayClient = {
			query: async(sql: string, params?: unknown[]) => await pool.query(sql, params),
			connect: async() => {
				const client = await pool.connect()
				return {
					query: async(sql: string, params?: unknown[]) => {
						const result = await client.query(sql, params)
						if (shouldPause && sql.includes(`${prefix}_records`) && sql.includes('WHERE audit_record.idempotency_hash = $1')) {
							shouldPause = false
							markReplayRead()
							await replayRelease
						}
						return result
					},
					release: () => client.release()
				}
			}
		}
		const replayStore = createPostgresAuditStore({client: replayClient as never, tablePrefix: prefix})
		await replayStore.verifyCompatibility()
		const completions: string[] = []
		const replayPromise = replayStore.appendMany([makeReplay('2020-01-02T00:00:00.000Z')])
			.then((result) => { completions.push('replay'); return result })
		await replayRead
		const prunePromise = store.prunePlanned!(plan)
			.then((result) => { completions.push('prune'); return result })

		let waitingLocks = 0
		try {
			const deadline = Date.now() + 2_000
			do {
				const waiting = await pool.query<{count: string}>(`SELECT count(*)::text AS count FROM pg_locks
					WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
					AND NOT granted`)
				waitingLocks = Number(waiting.rows[0]?.count ?? 0)
				if (!waitingLocks) await new Promise((resolve) => setTimeout(resolve, 10))
			} while (!waitingLocks && Date.now() < deadline)
			expect(waitingLocks).toBeGreaterThan(0)
		} finally { releaseReplay() }

		const [replay, pruned] = await Promise.all([replayPromise, prunePromise])
		expect(replay[0]).toMatchObject({inserted: false, record: {id: original[0]!.record.id}})
		expect(pruned).toEqual({deletedCount: 1})
		expect(completions).toEqual(['replay', 'prune'])
		await expect(store.appendMany([makeReplay('2020-01-03T00:00:00.000Z')])).rejects.toThrow(/pruned record/)
	})

	it('verifies a chain across the 500-record PostgreSQL page boundary', async() => {
		const firstPage = Array.from({length: 500}, (_, index) => prepared(
			`page-boundary-${String(index).padStart(3, '0')}`,
			undefined,
			'page-boundary'
		))
		const firstResults = await store.appendMany(firstPage)
		const finalResult = await store.appendMany([prepared('page-boundary-500', undefined, 'page-boundary')])
		const partitionKey = firstResults[0]!.record.integrity.partitionKey

		expect(finalResult[0]!.record.integrity.sequence).toBe(501)
		expect(await store.verifyIntegrity!({partitionKey})).toMatchObject({ok: true, checkedCount: 501})
	}, 15_000)

	it('does not extend a colliding legacy tenant-global chain with a new global record', async() => {
		const stream = 'legacy-global-collision'
		const legacyPrepared = normalizeAuditWriteRequest(clock, {
			id: 'legacy-tenant-global-live', eventType: 'audit.live', category: 'audit', action: 'record',
			actor: {kind: 'service'}, target: {entityType: 'record', entityId: 'legacy-tenant-global-live'},
			outcome: 'succeeded', sensitivity: 'high', tenantId: 'global', stream
		} as never)
		const inserted = await store.appendMany([legacyPrepared])
		const modernPartition = inserted[0]!.record.integrity.partitionKey
		const legacyPartition = `global:${stream}:2024-01-01`
		const legacyIntegrity = buildAuditIntegrity(
			{...legacyPrepared, partitionKey: legacyPartition},
			{sequence: 1, prevHash: null}
		)
		await pool.query(`UPDATE ${prefix}_records SET partition_key = $1, hash = $2 WHERE id = $3`, [
			legacyPartition, legacyIntegrity.hash, legacyPrepared.id
		])
		await pool.query(`UPDATE ${prefix}_chain_heads SET partition_key = $1, last_hash = $2 WHERE partition_key = $3`, [
			legacyPartition, legacyIntegrity.hash, modernPartition
		])
		expect(await store.verifyIntegrity!({partitionKey: legacyPartition})).toMatchObject({ok: true, checkedCount: 1})

		const globalPrepared = normalizeAuditWriteRequest(clock, {
			id: 'new-global-live', eventType: 'audit.live', category: 'audit', action: 'record',
			actor: {kind: 'service'}, target: {entityType: 'record', entityId: 'new-global-live'},
			outcome: 'succeeded', sensitivity: 'high', stream
		} as never)
		await expect(store.appendMany([globalPrepared])).rejects.toThrow(/chain head/)
		expect(await store.getById('new-global-live')).toBeUndefined()
	})

	it('keeps caller-owned transactional writes inside the caller transaction', async() => {
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await client.query('SET LOCAL search_path = pg_catalog')
			await store.appendTransactional!(client, [prepared('rolled-back', undefined, 'transaction')])
			await client.query('ROLLBACK')
		} finally {
			client.release()
		}

		expect(await store.getById('rolled-back')).toBeUndefined()
	})

	it('rejects caller-owned writes when configured with a dedicated connection', async() => {
		const client = await pool.connect()
		try {
			const dedicatedStore = createPostgresAuditStore({client, tablePrefix: prefix})
			await expect(dedicatedStore.appendTransactional!(
				client,
				[prepared('dedicated-caller-transaction', undefined, 'dedicated-transaction')]
			)).rejects.toThrow(/PostgreSQL pool is unverified/)
		} finally {
			client.release()
		}

		expect(await store.getById('dedicated-caller-transaction')).toBeUndefined()
	})

	it('rejects stale prune plans after the selected partition changes', async() => {
		await store.appendMany([prepared('stale-first', undefined, 'stale-prune')])
		const plan = await store.planPruneBefore!('2025-01-01T00:00:00.000Z', 10)
		await store.appendMany([prepared('stale-second', undefined, 'stale-prune')])

		await expect(store.prunePlanned!(plan)).rejects.toThrow(/stale/)
		expect(await store.getById('stale-first')).toBeDefined()
	})
})
