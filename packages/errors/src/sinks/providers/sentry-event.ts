import type {EnrichedError} from '../../types/normalized-error'
import {generateErrorId} from '../../utils/error-id'
import {redactEnrichedError} from '../../utils/redaction'
import type {SentryErrorSinkConfig} from '../types'

import type {ParsedSentryDsn} from './sentry-dsn'
import {sanitizeSentryExtra, sanitizeSentryString, sanitizeSentryTags, sanitizeSentryTagValue, sentryStackFrames} from './sentry-sanitization'

type SentryEventConfig = Omit<SentryErrorSinkConfig, 'dsn' | 'requestTimeoutMs'>

let fallbackEventSequence = 0
const eventId = (): string => {
	const candidate = generateErrorId()?.replace(/[^a-f0-9]/giu, '') ?? ''
	if (candidate.length >= 16) return candidate.padEnd(32, '0').slice(0, 32)
	fallbackEventSequence = (fallbackEventSequence + 1) % Number.MAX_SAFE_INTEGER
	return fallbackEventSequence.toString(16).padStart(32, '0')
}

const eventTimestamp = (value: number): string => {
	const timestamp = Number.isFinite(value) ? value : Date.now()
	try { return new Date(timestamp).toISOString() } catch { return new Date(0).toISOString() }
}

export function createSentryEvent(error: EnrichedError, config: Readonly<SentryEventConfig>) {
	const safeError = redactEnrichedError(error)
	const frames = sentryStackFrames(safeError.stack)
	const configuredTags = sanitizeSentryTags(config.tags ?? {})
	const runtimeTags = sanitizeSentryTags({
		category: safeError.category, severity: safeError.severity,
		...(safeError.code ? {code: safeError.code} : {}),
		...(safeError.source ? {source: safeError.source} : {})
	})
	return {
		event_id: eventId(),
		timestamp: eventTimestamp(safeError.timestamp),
		level: safeError.severity === 'warn' ? 'warning' : safeError.severity,
		platform: 'javascript',
		logger: '@ooopsstudio/errors',
		...(config.environment ? {environment: sanitizeSentryTagValue('environment', config.environment)} : {}),
		...(config.release ? {release: sanitizeSentryTagValue('release', config.release)} : {}),
		...(config.serverName ? {server_name: sanitizeSentryTagValue('server_name', config.serverName)} : {}),
		tags: {...configuredTags, ...runtimeTags},
		extra: sanitizeSentryExtra({
			context: safeError.context, correlationId: safeError.correlationId,
			traceId: safeError.traceId, data: safeError.data, cause: safeError.cause
		}),
		exception: {values: [{
			type: sanitizeSentryString(safeError.kind),
			value: sanitizeSentryString(safeError.message),
			...(frames ? {stacktrace: {frames}} : {})
		}]},
		sdk: {name: '@ooopsstudio/errors'}
	}
}

export function buildSentryEnvelope(
	event: ReturnType<typeof createSentryEvent>,
	parsed: ParsedSentryDsn
): string {
	const headers = {event_id: event.event_id, dsn: parsed.envelopeDsn, sent_at: new Date().toISOString()}
	const item = {type: 'event', content_type: 'application/json'}
	return `${JSON.stringify(headers)}\n${JSON.stringify(item)}\n${JSON.stringify(event)}`
}
