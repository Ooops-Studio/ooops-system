import {Session} from 'node:inspector/promises'

import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CpuProfileArtifact, CpuProfiler} from '@ooopsstudio/core/ports/profiling'
import {createSystemClock} from '@ooopsstudio/core/runtime/time/system-clock'

import {sanitizeProfileLabels, sanitizeProfileName} from './labels'

export interface InspectorProfilerOptions {clock?: Clock; maxPayloadBytes?: number}

const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
const addAbortEventListener = EventTarget.prototype.addEventListener
const removeAbortEventListener = EventTarget.prototype.removeEventListener
const ignore = () => undefined
const failure = (code: string) => Error(`profiling_${code}`)
const byteLength = Buffer.byteLength
const stringify = JSON.stringify
const MAX_PROFILE_ENTRIES = 262_144
const PROCESS_OWNERS = Symbol.for('@ooops/profiling:owners:v1')
type ProcessOwners = {
	m?: object; i?: symbol; ir?: () => Promise<boolean>; c?: object; p?: symbol
	s: WeakMap<object, object>; d: WeakMap<object, object>
}
const processScope = process as typeof process & {[PROCESS_OWNERS]?: ProcessOwners}
const owners = processScope[PROCESS_OWNERS]
	?? (processScope[PROCESS_OWNERS] = {s: new WeakMap(), d: new WeakMap()})

function readDataMethod(target: object, key: PropertyKey): unknown {
	let current: object | null = target
	for (let depth = 0; current && depth < 8; depth++) {
		let descriptor: PropertyDescriptor | undefined
		try { descriptor = Object.getOwnPropertyDescriptor(current, key) } catch { throw failure('invalid_options') }
		if (descriptor) {
			if (!('value' in descriptor)) throw failure('invalid_options')
			return descriptor.value
		}
		try { current = Object.getPrototypeOf(current) as object | null } catch { throw failure('invalid_options') }
	}
	return undefined
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
	if (!signal) return false
	try {
		if (typeof abortSignalAborted !== 'function') throw Error()
		return abortSignalAborted.call(signal) === true
	} catch { throw failure('invalid_capture_options') }
}

const aborted = () => Error('profile_aborted')
const settleWithin = async(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([operation, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(failure('inspector_cleanup_timeout')), timeoutMs)
		})])
		return true
	} catch { return false } finally { if (timer) clearTimeout(timer) }
}

function stringifyProfile(value: object, maxBytes: number): string {
	let bytes = 0; let entriesVisited = 0; let chunk = ''
	const parts: string[] = []
	const seen = new WeakSet<object>(); const tooLarge = {}; const invalidResult = {}
	const write = (value: string): void => {
		bytes += byteLength(value)
		if (bytes > maxBytes) throw tooLarge
		chunk += value
		if (chunk.length >= 4_096) { parts.push(chunk); chunk = '' }
	}
	const quote = (value: string): void => {
		let size = byteLength(value) + 2
		if (size > maxBytes - bytes) throw tooLarge
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index)
			if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) size++
			else if (code < 32) size += 5
			else if (code >> 11 === 27) {
				if (code >> 10 === 54 && value.charCodeAt(index + 1) >> 10 === 55) index++
				else size += 3
			}
			if (size > maxBytes - bytes) throw tooLarge
		}
		write(stringify(value))
	}
	const visit = (current: unknown, depth: number, arrayValue = false): boolean => {
		if (current === null) { write('null'); return true }
		if (typeof current === 'string') { quote(current); return true }
		if (typeof current === 'number') { write(Number.isFinite(current) ? String(current) : 'null'); return true }
		if (typeof current === 'boolean') { write(current ? 'true' : 'false'); return true }
		if (typeof current === 'undefined' || typeof current === 'function' || typeof current === 'symbol') {
			if (arrayValue) write('null')
			return arrayValue
		}
		if (typeof current !== 'object' || depth > 128 || seen.has(current)) throw invalidResult
		seen.add(current)
		try {
			const array = Array.isArray(current)
			const keys = Reflect.ownKeys(current)
			entriesVisited += keys.length
			if (keys.length > (maxBytes + 1) / 2 || entriesVisited > MAX_PROFILE_ENTRIES) throw tooLarge
			write(array ? '[' : '{')
			let entries = 0
			if (array) {
				const length = Object.getOwnPropertyDescriptor(current, 'length')?.value
				if (!Number.isSafeInteger(length) || length < 0 || length > (maxBytes + 1) / 2) throw tooLarge
				for (let index = 0; index < length; index++) {
					if (index) write(',')
					const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
					if (descriptor && !('value' in descriptor)) throw invalidResult
					visit(descriptor?.value, depth + 1, true)
				}
			} else for (const key of keys) {
				if (typeof key !== 'string') continue
				const descriptor = Object.getOwnPropertyDescriptor(current, key)
				if (!descriptor?.enumerable) continue
				if (!('value' in descriptor)) throw invalidResult
				const child = descriptor.value
				if (typeof child === 'undefined' || typeof child === 'function' || typeof child === 'symbol') continue
				if (entries++) write(',')
				quote(key); write(':'); visit(child, depth + 1)
			}
			write(array ? ']' : '}')
			return true
		} finally { seen.delete(current) }
	}
	try {
		visit(value, 0)
		return parts.join('') + chunk
	} catch(error) {
		if (error === tooLarge) throw Error('profile_too_large')
		throw failure('invalid_inspector_result')
	}
}
export function createInspectorProfiler(options: InspectorProfilerOptions = {}): CpuProfiler {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('invalid_options')
	let configuredClock: Clock | undefined; let configuredMaxPayloadBytes: number | undefined
	try {
		const clockDescriptor = Object.getOwnPropertyDescriptor(options, 'clock')
		const payloadDescriptor = Object.getOwnPropertyDescriptor(options, 'maxPayloadBytes')
		if ((clockDescriptor && !('value' in clockDescriptor)) || (payloadDescriptor && !('value' in payloadDescriptor))) throw Error()
		configuredClock = clockDescriptor?.value as Clock | undefined
		configuredMaxPayloadBytes = payloadDescriptor?.value as number | undefined
	} catch { throw failure('invalid_options') }
	const clock = configuredClock ?? createSystemClock()
	let nowMethod: Clock['now'] | undefined
	try { nowMethod = readDataMethod(clock, 'now') as Clock['now'] | undefined } catch { throw failure('invalid_clock') }
	if (!clock || typeof nowMethod !== 'function') throw failure('invalid_clock')
	const now = () => {
		try {
			const value = nowMethod.call(clock)
			if (typeof value !== 'number') void Promise.resolve(value).catch(ignore)
			return value
		} catch { throw failure('invalid_clock') }
	}
	const maxPayloadBytes = configuredMaxPayloadBytes ?? 16 * 1024 * 1024
	if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0 || maxPayloadBytes > 64 * 1024 * 1024) throw failure('invalid_payload_limit')
	const owner = Symbol('inspector-profiler-owner')
	return {
		async capture(input: Parameters<CpuProfiler['capture']>[0]): Promise<CpuProfileArtifact> {
			if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_capture_options')
			if (owners.c || owners.p) throw new Error('capture_in_progress')
			if (owners.i && (!await owners.ir?.() || owners.i)) throw new Error('capture_in_progress')
			owners.i = owner
			const release = (): void => {
				if (owners.i === owner) { delete owners.i; delete owners.ir }
			}
			let type: Parameters<CpuProfiler['capture']>[0]['type']; let durationMs: number | undefined
			let name: string | undefined; let labels: Record<string, string> | undefined
			let signal: AbortSignal | undefined
			try {
				try {
					const read = (key: PropertyKey): unknown => {
						const descriptor = Object.getOwnPropertyDescriptor(input, key)
						if (!descriptor) return undefined
						if (!('value' in descriptor)) throw new Error('invalid accessor')
						return descriptor.value
					}
					type = read('type') as typeof type
					durationMs = read('durationMs') as number | undefined
					name = read('name') as string | undefined
					labels = sanitizeProfileLabels(read('labels') as Record<string, string> | undefined)
					signal = read('signal') as AbortSignal | undefined
					if (signal) isSignalAborted(signal)
				} catch { throw failure('invalid_capture_options') }
				if (owners.m && (!signal || owners.s.get(signal) !== owners.m)) throw new Error('capture_in_progress')
				if (type !== 'cpu') throw failure('cpu_only')
				if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 30_000)) throw failure('invalid_duration')
				if (isSignalAborted(signal)) throw aborted()
			} catch(error) {
				release()
				throw error
			}
			let session: Session; let startedAt: number
			try {
				session = new Session(); startedAt = now()
				if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw failure('invalid_clock')
			} catch(error) {
				release()
				throw error
			}
			let stopped = false; let connectAttempted = false; let connected = false
			let phase: 'starting' | 'waiting' | 'stopping' = 'starting'
			let startOperation: Promise<unknown> | undefined
			let stopOperation: Promise<unknown> | undefined
			let onAbort: (() => void) | undefined
			let abortError: Error | undefined
			let abortTimer: ReturnType<typeof setTimeout> | undefined
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined
			let rejectCancellation!: (reason: Error) => void
			const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
			void cancellation.catch(ignore)
			const disconnect = (): boolean => {
				if (!connectAttempted) return true
				try {
					session.disconnect()
					connected = false; connectAttempted = false
					return true
				} catch { return false /* keep the session marked connected so final cleanup can stop and retry */ }
			}
			const cancel = (error: Error) => {
				abortError ??= error
				if (abortTimer) clearTimeout(abortTimer)
				if (phase !== 'waiting') disconnect()
				rejectCancellation(abortError)
			}
			const post = async(method: 'Profiler.enable' | 'Profiler.start' | 'Profiler.stop', track?: boolean) => {
				const operation = Promise.resolve().then(() => session.post(method))
				if (track) startOperation = operation
				if (method === 'Profiler.stop') stopOperation = operation
				return await Promise.race([operation, cancellation])
			}
			const stopConnected = async(): Promise<void> => {
				const cleanup = stopOperation ??= Promise.resolve().then(() => session.post('Profiler.stop'))
				stopped = await settleWithin(cleanup, 1_000)
				if (!stopped) void cleanup.then(() => { stopped = true; release() }, () => {
					if (stopOperation === cleanup) stopOperation = undefined
				})
			}
			const finishCleanup = (): boolean => {
				return disconnect() || stopped ? (release(), true) : (owners.ir = retryCleanup, false)
			}
			const retryCleanup = async(): Promise<boolean> => {
				if (owners.i !== owner) return true
				// Never wait behind or duplicate an ambiguous physical stop.
				if (!stopped && connected && !stopOperation) await stopConnected()
				return finishCleanup()
			}
			try {
				onAbort = () => cancel(aborted())
				if (signal) addAbortEventListener.call(signal, 'abort', onAbort, {once: true})
				if (isSignalAborted(signal)) throw aborted()
				deadlineTimer = setTimeout(() => cancel(failure('capture_timeout')), (durationMs ?? 1_000) + 1_000)
				connectAttempted = true; session.connect(); connected = true; await post('Profiler.enable'); await post('Profiler.start', true)
				if (isSignalAborted(signal)) throw aborted()
				phase = 'waiting'
				await Promise.race([new Promise<void>((resolve) => {
					abortTimer = setTimeout(resolve, durationMs ?? 1_000)
					if (isSignalAborted(signal)) onAbort?.()
				}), cancellation])
				abortTimer = undefined
				phase = 'stopping'
				const stopResult = await post('Profiler.stop') as unknown as {profile?: unknown} | null
				stopped = true
				let profile: unknown
				try { profile = stopResult && typeof stopResult === 'object' ? readDataMethod(stopResult, 'profile') : undefined }
				catch { throw failure('invalid_inspector_result') }
				if (abortError) throw abortError
				if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
					throw failure('invalid_inspector_result')
				}
				const payload = stringifyProfile(profile, maxPayloadBytes)
				const observedEndedAt = now()
				if (!Number.isSafeInteger(observedEndedAt) || observedEndedAt < 0) throw failure('invalid_clock')
				const endedAt = Math.max(startedAt, observedEndedAt)
				return Object.freeze({type: 'cpu', format: 'cpuprofile', name: sanitizeProfileName(name, 'performance.cpu'), startedAt, endedAt, durationMs: endedAt - startedAt, captured: true, payload, ...(labels ? {labels: Object.freeze({...labels})} : {}), resource: Object.freeze({})})
			} finally {
				if (deadlineTimer) clearTimeout(deadlineTimer)
				if (abortTimer) clearTimeout(abortTimer)
				try { if (signal && onAbort) removeAbortEventListener.call(signal, 'abort', onAbort) } catch { /* cleanup continues below */ }
				const pendingStart = phase === 'starting' && startOperation
				if (pendingStart) {
					const lateFence = pendingStart.catch(ignore).then(async() => {
						if (connected) await stopConnected()
						finishCleanup()
					})
					void lateFence.catch(ignore)
				} else {
					if (!stopped && connected) await stopConnected()
					// Release admission only after stop or disconnect proves the session inactive.
					finishCleanup()
				}
			}
		}
	}
}
