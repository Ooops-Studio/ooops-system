
import {snapshotExternalLoggingSink} from '../sinks/external'
import type {LoggingSinkConfig} from '../sinks/types'
import {snapshotLoggingSinkConfig} from '../sinks/validation'
import type {Sink} from '../types/sink'
import type {LogLine} from '../types/transferring'
import {readLoggingDataProperty} from '../utils/capabilities'
import {snapshotLoggingOptions} from '../utils/options'

export type LoggingRemoteInput = LoggingSinkConfig | {
	readonly provider: 'custom'
	readonly sink: Sink<LogLine>
}

export type LoggingRemoteSnapshot = LoggingSinkConfig | {
	readonly provider: 'custom'
	readonly sink: Sink<LogLine>
}

export function snapshotLoggingRemote(
	remote: LoggingRemoteInput | undefined,
	label: string
): LoggingRemoteSnapshot | undefined {
	if (remote === undefined) return undefined
	if (Array.isArray(remote)) throw new Error(`${label} accepts at most one remote sink.`)
	const provider = readLoggingDataProperty<unknown>(remote, 'provider')
	if (provider === 'custom') {
		const snapshot = snapshotLoggingOptions<{provider: 'custom'; sink: unknown}>(
			remote, ['provider', 'sink'], `${label} remote`
		)
		// Capture every callable capability before construction reaches its first
		// await. Retaining only the sink object would let the caller replace write,
		// flush, or close while preset chunks are loading and redirect admitted logs.
		return {provider: 'custom', sink: snapshotExternalLoggingSink(snapshot.sink)}
	}
	if (provider !== 'http' && provider !== 'loki') {
		throw new Error(`${label} remote must be http, loki, or custom.`)
	}
	return snapshotLoggingSinkConfig(remote)
}

export async function resolveLoggingRemote(
	remote: LoggingRemoteSnapshot | undefined
): Promise<Sink<LogLine> | undefined> {
	if (remote === undefined) return undefined
	if (remote.provider === 'custom') return remote.sink
	const {createLoggingSink} = await import('../sinks')
	return await createLoggingSink(remote)
}
