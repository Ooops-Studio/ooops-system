import type {
	FlatJobsBackendRuntime,
	JobsBackend,
	JobsSqlAdapterPort,
	JobsSqlQueryPort
} from '../../types/backend'
import type {JobsSqlBackendOptions} from '../../types/jobs'

import {composeJobsBackend} from './backend-input-guard'
import {createSqlAdminOperations} from './sql-admin-operations'
import {
	assertNativeJobsSchemaCompatible,
	qualifyJobsSql,
	readJobsSqlTransactionIdentity,
	validateSqlOptions
} from './sql-helpers'
import {createSqlRunOperations, type SqlBackendContext} from './sql-run-operations'
import {createSqlScheduleOperations} from './sql-schedule-operations'

export function createSqlJobsBackend(options: JobsSqlBackendOptions): JobsBackend {
	const {sql, namespace = 'jobs:scheduler'} = validateSqlOptions(options)
	let initialized: Promise<void> | undefined
	let verifiedSchema: string | undefined
	const ready = async(): Promise<void> => {
		if (!initialized) {
			const pending = sql.transaction(async(transaction) => {
				await transaction.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
				const firstTransactionIdentity = await readJobsSqlTransactionIdentity(transaction)
				const schemaName = await assertNativeJobsSchemaCompatible(transaction, namespace)
				const secondTransactionIdentity = await readJobsSqlTransactionIdentity(transaction)
				if (firstTransactionIdentity !== secondTransactionIdentity) {
					throw new Error('Jobs SQL adapter requires a real PostgreSQL transaction')
				}
				return schemaName
			}).then((schemaName) => {
				if (verifiedSchema !== undefined && verifiedSchema !== schemaName) {
					throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
				}
				verifiedSchema = schemaName
			})
			initialized = pending
			void pending.catch(() => { if (initialized === pending) initialized = undefined })
		}
		return initialized
	}
	const bindQuery = (queryable: JobsSqlQueryPort): JobsSqlQueryPort => ({
		async query<T = unknown>(statement: string, params?: ReadonlyArray<unknown>) {
			await ready()
			if (!verifiedSchema) throw new Error('JOBS_SCHEMA_INCOMPATIBLE')
			return queryable.query<T>(qualifyJobsSql(statement, verifiedSchema), params)
		}
	})
	const runtimeSql: JobsSqlAdapterPort = {
		...bindQuery(sql),
		async transaction<T>(callback: (transaction: JobsSqlQueryPort) => Promise<T>): Promise<T> {
			await ready()
			return sql.transaction(async(transaction) => await callback(bindQuery(transaction)))
		}
	}
	const context: SqlBackendContext = {sql: runtimeSql, namespace, ready}
	return composeJobsBackend({
		durability: 'durable',
		...createSqlRunOperations(context),
		...createSqlScheduleOperations(context),
		...createSqlAdminOperations(context)
	} as FlatJobsBackendRuntime)
}
