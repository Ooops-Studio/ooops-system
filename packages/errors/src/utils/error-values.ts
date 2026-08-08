import type {ErrorCategory, ErrorSeverity} from '../types/normalized-error'

export const SEVERITY_LEVELS: ReadonlyArray<ErrorSeverity> = ['info', 'warn', 'error', 'fatal'] as const

export const ERROR_CATEGORIES: ReadonlyArray<ErrorCategory> = [
	'VALIDATION', 'NETWORK', 'CONFIG', 'AUTHENTICATION', 'AUTHORIZATION',
	'RATE_LIMIT', 'TIMEOUT', 'RESOURCE', 'BUSINESS_LOGIC', 'UNKNOWN'
] as const
