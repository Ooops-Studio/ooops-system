import type {DBQueryMetadata} from '@ooopsstudio/core/contracts/performance'
import type {PerformancePort} from '@ooopsstudio/core/ports/performance'
import {hash32Hex} from '@ooopsstudio/core/utils/hashing'

import {capturePerformanceMethod, ignorePromiseRejection} from './performance-port-method'
import {runBoundedRuntimeReflection} from './reflection-flight'
import {isRuntimeProxy} from './runtime-object'

const PRIVATE_LABEL = /access|api.?key|auth|bear|cook|cred|id$|jwt|^key$|mail|oauth|pass|priv|secr|sess|token/i
const isSafeTelemetryLabelKey = (key: string): boolean =>
	/^[a-z_][\w.-]{0,63}$/i.test(key) && !PRIVATE_LABEL.test(key)

interface BaseDBAdapterOptions {
	performance?: PerformancePort
	name?: string
	labels?: Record<string, string>
	operation?: string
	table?: string
	collection?: string
	rows?: number
	query?: string
}

export interface PgQueryOptions extends BaseDBAdapterOptions {
	text?: string
}

export interface DrizzleQueryOptions extends BaseDBAdapterOptions {
	sql?: string
}

export interface PrismaQueryOptions extends BaseDBAdapterOptions {
	model?: string
	action: string
}

export interface KyselyQueryOptions extends BaseDBAdapterOptions {
	sql?: string
}

const SQL_OPERATION = /^(select|insert|update|delete|with|merge)\b/i
const SQL_TABLE = /\bfrom\s+["`]?([a-z0-9_.-]+)["`]?|\binto\s+["`]?([a-z0-9_.-]+)["`]?|\bupdate\s+["`]?([a-z0-9_.-]+)["`]?/i
const MAX_QUERY_LENGTH = 16_384
const DB_IDENTIFIER = /^[a-z0-9_][a-z0-9_.-]*$/i
const METRIC_NAME = /^[a-z][a-z0-9_.-]*$/i
const OPTION_FIELDS = [
	'performance', 'name', 'labels', 'operation', 'table', 'collection', 'rows', 'query',
	'text', 'sql', 'model', 'action'
] as const

type DBQueryMethod = NonNullable<DBQueryMetadata['method']>

const safeDBDimension = (value: unknown, maximum = 256): string | undefined =>
	typeof value === 'string' && value.length <= maximum && DB_IDENTIFIER.test(value) && !/[\d@]/.test(value)
		? value : undefined

const hasSafePrototypeChain = (value: unknown): boolean => {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
	try {
		return runBoundedRuntimeReflection(() => {
			let owner: object | null = value
			for (let depth = 0; owner && depth < 32; depth += 1) {
				if (isRuntimeProxy(owner)) return false
				owner = Object.getPrototypeOf(owner) as object | null
			}
			return owner === null
		})
	} catch { return false }
}

const snapshotLabels = (value: unknown): Record<string, string> | undefined => {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value) || Array.isArray(value)) return undefined
	const result: Record<string, string> = Object.create(null) as Record<string, string>
	try {
		runBoundedRuntimeReflection(() => {
			const prototype = Object.getPrototypeOf(value)
			if (prototype !== Object.prototype && prototype !== null) throw new TypeError()
			const keys = Reflect.ownKeys(value)
			if (keys[32]) throw new TypeError()
			for (const key of keys) {
				if (typeof key !== 'string') throw new TypeError()
				const descriptor = Object.getOwnPropertyDescriptor(value, key)
				if (!isSafeTelemetryLabelKey(key) || !descriptor?.enumerable ||
					!('value' in descriptor) || typeof descriptor.value !== 'string') continue
				result[key] = descriptor.value.slice(0, 256)
			}
		})
		return result
	} catch { return undefined }
}

const mapOperationToMethod = (operation?: string): DBQueryMethod => {
	switch (operation?.toLowerCase()) {
		case 'select':
		case 'findmany':
		case 'findfirst':
		case 'findunique':
			return 'list'
		case 'insert':
		case 'create':
		case 'createmany':
			return 'create'
		case 'update':
		case 'updatemany':
			return 'update'
		case 'delete':
		case 'deletemany':
			return 'delete'
		default:
			return 'get'
	}
}

const parseOperation = (query?: string, fallback?: string): string | undefined => {
	if (typeof fallback === 'string') {
		return safeDBDimension(fallback, 64)
	}
	const match = query?.trim().match(SQL_OPERATION)
	return match?.[1]?.toLowerCase()
}

const parseTable = (query?: string, table?: string, collection?: string): {table?: string; collection?: string} => {
	if (typeof table === 'string' || typeof collection === 'string') {
		const safeTable = safeDBDimension(table)
		const safeCollection = safeDBDimension(collection)
		return {
			...(safeTable ? {table: safeTable} : {}),
			...(safeCollection ? {collection: safeCollection} : {})
		}
	}
	const match = query?.match(SQL_TABLE)
	const parsed = match?.[1] ?? match?.[2] ?? match?.[3]
	const safeParsed = safeDBDimension(parsed)
	return safeParsed ? {table: safeParsed, collection: safeParsed} : {}
}

const extractRowCount = (result: unknown): number | undefined => {
	if (isRuntimeProxy(result)) return undefined
	try {
		return runBoundedRuntimeReflection(() => {
			if (Array.isArray(result)) {
				const descriptor = Object.getOwnPropertyDescriptor(result, 'length')
				return descriptor && 'value' in descriptor && Number.isSafeInteger(descriptor.value)
					? descriptor.value as number : undefined
			}
			if (typeof result === 'object' && result !== null) {
				for (const key of ['rowCount', 'count'] as const) {
					const descriptor = Object.getOwnPropertyDescriptor(result, key)
					if (descriptor && 'value' in descriptor && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0) return descriptor.value
				}
				const descriptor = Object.getOwnPropertyDescriptor(result, 'rows')
				if (descriptor && 'value' in descriptor && !isRuntimeProxy(descriptor.value) && Array.isArray(descriptor.value)) {
					const length = Object.getOwnPropertyDescriptor(descriptor.value, 'length')
					return length && 'value' in length && Number.isSafeInteger(length.value)
						? length.value as number : undefined
				}
			}
			return undefined
		})
	} catch {
		return undefined
	}
}

const normalizeAdapterOptions = (
	value: unknown,
	driver: 'pg' | 'drizzle' | 'prisma' | 'kysely'
): BaseDBAdapterOptions | undefined => {
	if (!value || typeof value !== 'object' || isRuntimeProxy(value) || Array.isArray(value)) return undefined
	const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
	try {
		runBoundedRuntimeReflection(() => {
			for (const key of OPTION_FIELDS) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key)
				if (!descriptor) continue
				if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError()
				snapshot[key] = key === 'labels' ? snapshotLabels(descriptor.value) : descriptor.value
			}
		})
	} catch { return undefined }
	if (driver === 'prisma') {
		snapshot.operation ??= snapshot.action
		snapshot.collection ??= snapshot.model
	} else {
		const query = snapshot.query ?? (driver === 'pg' ? snapshot.text : snapshot.sql)
		snapshot.query = typeof query === 'string' && query.length <= MAX_QUERY_LENGTH ? query : undefined
	}
	return snapshot as BaseDBAdapterOptions
}

const buildMetadata = (options: BaseDBAdapterOptions): DBQueryMetadata => {
	const operation = parseOperation(options.query, options.operation)
	const metadata: DBQueryMetadata = {}
	if (operation) {
		metadata.operation = operation
		metadata.method = mapOperationToMethod(operation)
	}
	const tables = parseTable(options.query, options.table, options.collection)
	if (tables.table) {
		metadata.table = tables.table
	}
	if (tables.collection) {
		metadata.collection = tables.collection
	}
	const rows = options.rows
	if (Number.isSafeInteger(rows) && (rows as number) >= 0) {
		metadata.rows = rows as number
		metadata.documentCount = rows as number
	}
	if (options.query) {
		metadata.queryHash = hash32Hex(operation ?? tables.table ?? tables.collection ?? 'query')
	}
	return metadata
}

async function measureWithDBMetadata<T>(
	fn: () => Promise<T>,
	options: BaseDBAdapterOptions,
	driver: string
): Promise<T> {
	let performance: PerformancePort | undefined
	try {
		performance = options.performance
	} catch {
		return await fn()
	}
	let measureDBQuery: NonNullable<PerformancePort['measureDBQuery']> | undefined
	try { measureDBQuery = performance && hasSafePrototypeChain(performance)
		? runBoundedRuntimeReflection(() => capturePerformanceMethod(performance, 'measureDBQuery') as NonNullable<PerformancePort['measureDBQuery']> | undefined)
		: undefined } catch { /* unavailable instrumentation */ }
	if (!measureDBQuery) {
		return await fn()
	}

	let metadata: DBQueryMetadata
	try {
		metadata = buildMetadata(options)
	} catch {
		return await fn()
	}
	let operationPromise: Promise<T> | undefined
	const invokeOnce = (): Promise<T> => {
		operationPromise ??= Promise.resolve().then(fn)
		return operationPromise
	}
	try {
		const labels = options.labels
		const name = typeof options.name === 'string' && options.name.length <= 128 && METRIC_NAME.test(options.name)
			? options.name : 'db.query'
		const instrumentation = measureDBQuery(
			name,
			async() => {
				try {
					const result = await invokeOnce()
					metadata.success = true
					try {
						const rowCount = extractRowCount(result)
						if (rowCount !== undefined && metadata.rows === undefined) {
							metadata.rows = rowCount
							metadata.documentCount = rowCount
						}
					} catch {
						// Result-shape inspection is optional instrumentation.
					}
					return result
				} catch(error) {
					metadata.success = false
					// Raw database errors can contain SQL, credentials, or customer data.
					metadata.failureCode = 'query_failed'
					throw error
				}
			},
			metadata,
			{
				...(labels ?? {}),
				driver
			}
		)
		ignorePromiseRejection(instrumentation)
		await Promise.resolve()
	} catch {
		// The database operation remains authoritative over instrumentation.
	}
	return await invokeOnce()
}

export async function measurePgQuery<T>(
	fn: () => Promise<T>,
	options: PgQueryOptions
): Promise<T> {
	const normalized = normalizeAdapterOptions(options, 'pg')
	if (!normalized) return await fn()
	return await measureWithDBMetadata(fn, normalized, 'pg')
}

export async function measureDrizzleQuery<T>(
	fn: () => Promise<T>,
	options: DrizzleQueryOptions
): Promise<T> {
	const normalized = normalizeAdapterOptions(options, 'drizzle')
	if (!normalized) return await fn()
	return await measureWithDBMetadata(fn, normalized, 'drizzle')
}

export async function measurePrismaQuery<T>(
	fn: () => Promise<T>,
	options: PrismaQueryOptions
): Promise<T> {
	const normalized = normalizeAdapterOptions(options, 'prisma')
	if (!normalized) return await fn()
	return await measureWithDBMetadata(fn, normalized, 'prisma')
}

export async function measureKyselyQuery<T>(
	fn: () => Promise<T>,
	options: KyselyQueryOptions
): Promise<T> {
	const normalized = normalizeAdapterOptions(options, 'kysely')
	if (!normalized) return await fn()
	return await measureWithDBMetadata(fn, normalized, 'kysely')
}
