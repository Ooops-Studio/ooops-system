import type {CpuProfileArtifact, ProfileExporter} from '@ooopsstudio/core/ports/profiling'

import {sanitizeProfileLabels, sanitizeProfileName, sanitizeProfileReason} from './labels'

const byteLength = Buffer.byteLength
const stringify = JSON.stringify
const INVALID_OPTIONS = 'Memory profile exporter options must be an object'

export interface MemoryProfileExporter extends ProfileExporter {
	getProfiles(): ReadonlyArray<CpuProfileArtifact>
	clear(): void
	getDroppedCount(): number
}

export interface MemoryProfileExporterOptions {
	maxProfiles?: number
	maxBytes?: number
}

function estimateProfileBytes(profile: CpuProfileArtifact): number {
	return byteLength(stringify({
		...profile,
		payload: undefined
	})) + byteLength(profile.payload ?? '')
}

function snapshotProfileResource(value: unknown): Readonly<Record<string, string>> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const result: Record<string, string> = Object.create(null) as Record<string, string>
	try {
		const keys = Reflect.ownKeys(value)
		if (keys.length > 32) return undefined
		for (const key of keys) {
			if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/u.test(key)) return undefined
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable) continue
			if (!('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length > 256) return undefined
			for (let index = 0; index < descriptor.value.length; index++) {
				const code = descriptor.value.charCodeAt(index)
				if (code < 32 || code === 127) return undefined
			}
			const sanitized = sanitizeProfileLabels({[key]: descriptor.value})
			const entry = sanitized && Object.entries(sanitized)[0]
			if (entry && !(entry[0] in result)) result[entry[0]] = entry[1]
		}
	} catch { return undefined }
	return Object.freeze(result)
}

function cloneProfile(profile: CpuProfileArtifact): CpuProfileArtifact {
	return {
		...profile,
		...(profile.labels ? {labels: {...profile.labels}} : {}),
		resource: {...profile.resource}
	}
}

function readProfileField(value: object, key: keyof CpuProfileArtifact, optional = false): unknown {
	let descriptor: PropertyDescriptor | undefined
	try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { return undefined }
	if (!descriptor) return optional ? undefined : null
	return 'value' in descriptor ? descriptor.value : undefined
}

export function createMemoryProfileExporter(
	options: MemoryProfileExporterOptions = {}
): MemoryProfileExporter {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error(INVALID_OPTIONS)
	let maxProfilesDescriptor: PropertyDescriptor | undefined; let maxBytesDescriptor: PropertyDescriptor | undefined
	try {
		maxProfilesDescriptor = Object.getOwnPropertyDescriptor(options, 'maxProfiles')
		maxBytesDescriptor = Object.getOwnPropertyDescriptor(options, 'maxBytes')
	} catch { throw Error(INVALID_OPTIONS) }
	if ((maxProfilesDescriptor && !('value' in maxProfilesDescriptor)) || (maxBytesDescriptor && !('value' in maxBytesDescriptor))) {
		throw Error(INVALID_OPTIONS)
	}
	const configuredMaxProfiles = maxProfilesDescriptor?.value as number | undefined
	const configuredMaxBytes = maxBytesDescriptor?.value as number | undefined
	const maxProfiles = configuredMaxProfiles ?? 100
	const maxBytes = configuredMaxBytes ?? 10 * 1024 * 1024
	if (!Number.isInteger(maxProfiles) || maxProfiles <= 0 || maxProfiles > 10_000) {
		throw new Error('Memory profile exporter maxProfiles must be an integer between 1 and 10000')
	}
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024) {
		throw new Error('Memory profile exporter maxBytes must be between 1 and 67108864')
	}
	const profiles: CpuProfileArtifact[] = []
	let storedBytes = 0
	let dropped = 0
	let closed = false

	return {
		async export(profile: Readonly<CpuProfileArtifact>): Promise<void> {
			if (closed) { dropped += 1; return }
			if (!profile || typeof profile !== 'object' || Array.isArray(profile)) { dropped += 1; return }
			let snapshot: CpuProfileArtifact
			snapshot = {
				type: readProfileField(profile, 'type') as CpuProfileArtifact['type'],
				format: readProfileField(profile, 'format') as CpuProfileArtifact['format'],
				name: readProfileField(profile, 'name') as string,
				startedAt: readProfileField(profile, 'startedAt') as number,
				endedAt: readProfileField(profile, 'endedAt') as number,
				durationMs: readProfileField(profile, 'durationMs') as number,
				captured: readProfileField(profile, 'captured') as boolean,
				payload: readProfileField(profile, 'payload') as string,
				reason: readProfileField(profile, 'reason', true) as string | undefined,
				labels: readProfileField(profile, 'labels', true) as Readonly<Record<string, string>> | undefined,
				resource: readProfileField(profile, 'resource') as Readonly<Record<string, string>>
			}
			if (snapshot.type !== 'cpu' || snapshot.format !== 'cpuprofile'
				|| !Number.isSafeInteger(snapshot.startedAt) || snapshot.startedAt < 0
				|| !Number.isSafeInteger(snapshot.endedAt)
				|| snapshot.endedAt < snapshot.startedAt
				|| !Number.isSafeInteger(snapshot.durationMs) || snapshot.durationMs < 0
				|| snapshot.durationMs !== snapshot.endedAt - snapshot.startedAt
				|| snapshot.captured !== true
				|| typeof snapshot.payload !== 'string' || snapshot.payload.length === 0) {
				dropped += 1
				return
			}
			if (snapshot.payload.length > maxBytes || byteLength(snapshot.payload) > maxBytes) { dropped += 1; return }
			const labels = sanitizeProfileLabels(snapshot.labels)
			const resource = snapshotProfileResource(snapshot.resource)
			if (!resource) { dropped += 1; return }
			const reason = snapshot.captured ? undefined : sanitizeProfileReason(snapshot.reason)
			const sanitized: CpuProfileArtifact = {
				type: 'cpu', format: 'cpuprofile',
				name: sanitizeProfileName(snapshot.name, 'performance.cpu'),
				startedAt: snapshot.startedAt, endedAt: snapshot.endedAt,
				durationMs: snapshot.durationMs, captured: true, payload: snapshot.payload,
				...(reason ? {reason} : {}), ...(labels ? {labels} : {}), resource
			}
			const copy = cloneProfile(sanitized)
			const size = estimateProfileBytes(copy)
			if (size > maxBytes) {
				dropped += 1
				return
			}
			if (closed) { dropped += 1; return }
			while ((profiles.length >= maxProfiles || storedBytes + size > maxBytes) && profiles.length > 0) {
				const removed = profiles.shift()
				if (removed) {
					storedBytes -= estimateProfileBytes(removed)
					dropped += 1
				}
			}
			profiles.push(copy)
			storedBytes += size
		},
		getProfiles(): ReadonlyArray<CpuProfileArtifact> {
			return profiles.map(cloneProfile)
		},
		clear(): void {
			profiles.length = 0
			storedBytes = 0
		},
		async shutdown(): Promise<void> {
			closed = true
			profiles.length = 0
			storedBytes = 0
		},
		getDroppedCount(): number {
			return dropped
		}
	}
}
