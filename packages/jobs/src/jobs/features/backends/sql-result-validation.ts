import {snapshotProviderData} from './backend-validation'

function readSqlRowsDataProperty(value: object): unknown {
	let current: object | null = value
	try {
		for (let depth = 0; current && depth < 32; depth += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(current, 'rows')
			if (descriptor) {
				if (!('value' in descriptor)) throw new Error('accessor')
				return descriptor.value
			}
			current = Object.getPrototypeOf(current)
		}
	} catch { throw new Error('Jobs SQL returned an invalid result object') }
	return undefined
}

export function validateSqlRows<T>(value: unknown, maximum: number, label: string): T[] {
	if (!Number.isSafeInteger(maximum) || maximum < 0 || !value || typeof value !== 'object') {
		throw new Error(`Jobs SQL returned an invalid ${label}`)
	}
	try {
		const rows = snapshotProviderData(readSqlRowsDataProperty(value), `SQL ${label}`)
		if (!Array.isArray(rows) || rows.length > maximum) throw new Error('invalid')
		return rows as T[]
	} catch {
		throw new Error(`Jobs SQL returned an invalid ${label}`)
	}
}

export function validateUniqueSqlRows<T>(
	value: unknown,
	maximum: number,
	identity: (row: T) => string,
	label: string
): T[] {
	const rows = validateSqlRows<T>(value, maximum, label)
	let identities: string[]
	try { identities = rows.map(identity) } catch { throw new Error(`Jobs SQL returned an invalid ${label}`) }
	if (new Set(identities).size !== identities.length) throw new Error(`Jobs SQL returned duplicate ${label}`)
	return rows
}
