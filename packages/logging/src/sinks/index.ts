import type {Sink} from '../types/sink'
import type {LogLine} from '../types/transferring'

import type {LoggingSinkConfig} from './types'
import {snapshotLoggingSinkConfig, validateLoggingSinkConfig} from './validation'

export async function createLoggingSink(
	config: Readonly<LoggingSinkConfig>
): Promise<Sink<LogLine>> {
	const snapshot = snapshotLoggingSinkConfig(config)
	switch (snapshot.provider) {
		case 'loki': {
			if (!snapshot.url.trim()) {
				throw new Error('createLoggingSink: loki url is required')
			}
			validateLoggingSinkConfig(snapshot)
			const {createLokiLoggingSink} = await import('./providers/loki')
			return createLokiLoggingSink(snapshot)
		}
		case 'http': {
			if (!snapshot.url.trim()) {
				throw new Error('createLoggingSink: http url is required')
			}
			validateLoggingSinkConfig(snapshot)
			const {createHttpLoggingSink} = await import('./providers/http')
			return createHttpLoggingSink(snapshot)
		}
	}
	/* v8 ignore next -- provider is validated before the discriminated switch */
	throw new Error('createLoggingSink: unsupported provider invalid')
}

export type {
	HttpLoggingSinkConfig,
	LokiLoggingSinkConfig,
	LoggingSinkConfig
} from './types'
