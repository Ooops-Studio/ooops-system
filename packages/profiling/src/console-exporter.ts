import type {Console} from 'node:console'

import type {CpuProfileArtifact, ProfileExporter} from '@ooopsstudio/core/ports/profiling'

import {sanitizeProfileName, sanitizeProfileReason} from './labels'

const invalidProfile = (): Error => Error('profiling_invalid_console_profile')
const writeFailure = (): Error => Error('profiling_console_write_failure')

function readProfileField(value: object, key: keyof CpuProfileArtifact, optional = false): unknown {
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { throw invalidProfile() }
	if (!descriptor) {
		if (optional) return undefined
		throw invalidProfile()
	}
	if (!('value' in descriptor)) throw invalidProfile()
	return descriptor.value
}

export function createConsoleProfileExporter(
	consoleLike: Pick<Console, 'log'> = console
): ProfileExporter {
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = consoleLike && Object.getOwnPropertyDescriptor(consoleLike, 'log') } catch { throw Error('profiling_invalid_console') }
	const log = descriptor && 'value' in descriptor ? descriptor.value as Console['log'] : undefined
	if (!consoleLike || typeof log !== 'function') throw Error('profiling_invalid_console')
	return {
		async export(profile: Readonly<CpuProfileArtifact>): Promise<void> {
			if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw invalidProfile()
			const type = readProfileField(profile, 'type'); const format = readProfileField(profile, 'format')
			const name = readProfileField(profile, 'name'); const startedAt = readProfileField(profile, 'startedAt')
			const endedAt = readProfileField(profile, 'endedAt'); const durationMs = readProfileField(profile, 'durationMs')
			const captured = readProfileField(profile, 'captured'); const payload = readProfileField(profile, 'payload', true)
			const reason = readProfileField(profile, 'reason', true)
			if (type !== 'cpu' || format !== 'cpuprofile'
					|| typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt < 0
					|| typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0
					|| typeof endedAt !== 'number' || !Number.isSafeInteger(endedAt) || endedAt < startedAt
					|| durationMs !== endedAt - startedAt
					|| typeof captured !== 'boolean'
					|| (captured && (typeof payload !== 'string' || payload.length === 0))) {
				throw invalidProfile()
			}
			const safeReason = captured ? undefined : sanitizeProfileReason(typeof reason === 'string' ? reason : undefined)
			try {
				await log.call(consoleLike, JSON.stringify({
					type: 'cpu',
					name: sanitizeProfileName(typeof name === 'string' ? name : undefined, 'performance.cpu'),
					format: 'cpuprofile',
					durationMs,
					captured,
					...(safeReason ? {reason: safeReason} : {}),
					endedAt
				}))
			} catch { throw writeFailure() }
		}
	}
}
