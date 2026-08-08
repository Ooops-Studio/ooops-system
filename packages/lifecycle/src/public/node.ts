import type {LifecycleHookDisposer} from '@ooopsstudio/core/contracts/lifecycle'
import type {ManagedLifecycle} from '@ooopsstudio/core/ports/lifecycle'

import {
	boundedTimer,
	snapshotRecord
} from '../core/lifecycle-handler-validation'
import {attachLifecycleCleanup} from '../core/runtime-capabilities'

export type NodeLifecycleSignal = 'SIGTERM' | 'SIGINT'
export type NodeFatalErrorType = 'uncaughtException' | 'unhandledRejection'

export interface NodeLifecycleOptions {
	readonly signals?: readonly NodeLifecycleSignal[]
	readonly fatalErrors?: {
		readonly timeoutMs?: number
		readonly onFatalError?: (
			error: Error,
			type: NodeFatalErrorType
		) => void | Promise<void>
		readonly terminate: (exitCode: 1) => void | Promise<void>
	}
}

interface CapturedNodeLifecycleOptions {
	readonly signals: readonly NodeLifecycleSignal[]
	readonly fatalErrors?: {
		readonly timeoutMs: number
		readonly onFatalError?: (error: Error, type: NodeFatalErrorType) => void | Promise<void>
		readonly terminate: (exitCode: 1) => void | Promise<void>
	}
}

interface NodeLifecycleOwner {
	retryCleanup?: () => void
}

let owner: NodeLifecycleOwner | undefined

type LifecycleMethod = (...args: never[]) => unknown

function captureLifecycleMethod(lifecycle: object, key: PropertyKey): LifecycleMethod | undefined {
	let current: object | null = lifecycle
	const visited = new Set<object>()
	try {
		while (current && !visited.has(current) && visited.size < 32) {
			visited.add(current)
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
				? ((...args: never[]) => Reflect.apply(descriptor.value as LifecycleMethod, lifecycle, args))
				: undefined
			current = Object.getPrototypeOf(current) as object | null
		}
	} catch { return undefined }
	return undefined
}

function sanitizeFatalMessage(value: string): string {
	return value.slice(0, 8192).replace(
		/(password|token|secret|authorization)\s*[=:]\s*(?:bearer\s+)?[^\s,;]+|bearer\s+[^\s,;]+/giu,
		'$1=[REDACTED]'
	)
}

function sanitizeFatalError(value: unknown): Error {
	try {
		if (value && (typeof value === 'object' || typeof value === 'function')) {
			let message = 'Fatal process error'
			let name = 'Error'
			try {
				const descriptor = Object.getOwnPropertyDescriptor(value, 'message')
				if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
					message = sanitizeFatalMessage(descriptor.value)
				}
			} catch { /* hostile Error accessors are replaced with bounded diagnostics */ }
			try {
				const descriptor = Object.getOwnPropertyDescriptor(value, 'name')
				if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
					name = sanitizeFatalMessage(descriptor.value).slice(0, 128)
				}
			} catch { /* hostile Error accessors are replaced with bounded diagnostics */ }
			const error = new Error(message)
			error.name = name
			return error
		}
		return new Error(typeof value === 'string' ? sanitizeFatalMessage(value) : 'Fatal process error')
	} catch {
		return new Error('Fatal process error')
	}
}

async function bounded(action: () => void | Promise<void>, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			Promise.resolve().then(action),
			new Promise<void>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('LIFECYCLE_NODE_FATAL_TIMEOUT')), timeoutMs)
			})
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function captureOptions(options: NodeLifecycleOptions | undefined): CapturedNodeLifecycleOptions {
	const root = options === undefined
		? {}
		: snapshotRecord(options, 'Node lifecycle options', new Set(['signals', 'fatalErrors']))
	const rawSignals = root.signals
	const signals = rawSignals === undefined ? ['SIGTERM', 'SIGINT'] as const : (() => {
		if (!Array.isArray(rawSignals)) throw new TypeError('Node lifecycle signals must be an array')
		let length = -1
		try {
			const descriptor = Object.getOwnPropertyDescriptor(rawSignals, 'length')
			if (descriptor && 'value' in descriptor && Number.isSafeInteger(descriptor.value)) length = descriptor.value as number
		} catch { /* invalid below */ }
		if (length < 0 || length > 2) throw new TypeError('Node lifecycle signals are invalid')
		const unique = new Set<NodeLifecycleSignal>()
		for (let index = 0; index < length; index++) {
			let signal: unknown
			try {
				const descriptor = Object.getOwnPropertyDescriptor(rawSignals, String(index))
				signal = descriptor && 'value' in descriptor ? descriptor.value : undefined
			} catch { throw new TypeError('Node lifecycle signals must contain stable strings') }
			if (signal !== 'SIGTERM' && signal !== 'SIGINT') {
				throw new TypeError('Node lifecycle signal must be SIGTERM or SIGINT')
			}
			unique.add(signal)
		}
		return Object.freeze([...unique])
	})()
	const rawFatal = root.fatalErrors
	if (rawFatal === undefined) return Object.freeze({signals})
	const fatal = snapshotRecord(
		rawFatal,
		'Node lifecycle fatalErrors',
		new Set(['timeoutMs', 'onFatalError', 'terminate'])
	)
	if (typeof fatal.terminate !== 'function') {
		throw new TypeError('Node lifecycle fatalErrors.terminate must be a function')
	}
	if (fatal.onFatalError !== undefined && typeof fatal.onFatalError !== 'function') {
		throw new TypeError('Node lifecycle fatalErrors.onFatalError must be a function')
	}
	const timeoutMs = boundedTimer(fatal.timeoutMs, 10_000, 'fatalErrors.timeoutMs')
	const terminateMethod = fatal.terminate as (exitCode: 1) => void | Promise<void>
	const terminate = (exitCode: 1): void | Promise<void> => Reflect.apply(terminateMethod, undefined, [exitCode])
	const onFatalError = fatal.onFatalError === undefined
		? undefined
		: ((error: Error, type: NodeFatalErrorType): void | Promise<void> => Reflect.apply(
			fatal.onFatalError as (error: Error, type: NodeFatalErrorType) => void | Promise<void>,
			undefined,
			[error, type]
		))
	return Object.freeze({
		signals,
		fatalErrors: Object.freeze({timeoutMs, terminate, ...(onFatalError ? {onFatalError} : {})})
	})
}

/** Explicitly gives one lifecycle instance ownership of process termination events. */
export function attachNodeLifecycle(
	lifecycle: ManagedLifecycle,
	options?: NodeLifecycleOptions
): LifecycleHookDisposer {
	if (owner !== undefined) {
		if (!owner.retryCleanup) throw new Error('LIFECYCLE_NODE_OWNER_EXISTS')
		owner.retryCleanup()
		if (owner !== undefined) throw new Error('LIFECYCLE_NODE_OWNER_EXISTS')
	}
	const runtimeOwner: NodeLifecycleOwner = {}
	owner = runtimeOwner
	let captured: CapturedNodeLifecycleOptions
	let beginDrain: ManagedLifecycle['beginDrain']
	let shutdown: ManagedLifecycle['shutdown']
	let registerShutdownHook: ManagedLifecycle['registerShutdownHook']
	try {
		// Reserve process ownership before inspecting caller-controlled values;
		// descriptor traps must not be able to install a second adapter.
		const capturedBeginDrain = captureLifecycleMethod(lifecycle, 'beginDrain')
		const capturedShutdown = captureLifecycleMethod(lifecycle, 'shutdown')
		const capturedRegisterShutdownHook = captureLifecycleMethod(lifecycle, 'registerShutdownHook')
		if (!capturedBeginDrain || !capturedShutdown || !capturedRegisterShutdownHook) {
			throw new TypeError('Node lifecycle adapter requires a valid managed lifecycle runtime')
		}
		beginDrain = capturedBeginDrain as ManagedLifecycle['beginDrain']
		shutdown = capturedShutdown as ManagedLifecycle['shutdown']
		registerShutdownHook = capturedRegisterShutdownHook as ManagedLifecycle['registerShutdownHook']
		captured = captureOptions(options)
	} catch(error) {
		if (owner === runtimeOwner) owner = undefined
		throw error
	}
	let active = true

	const signalListeners = new Map<NodeLifecycleSignal, () => void>()
	const runFatal = async(value: unknown, type: NodeFatalErrorType): Promise<void> => {
		const fatal = captured.fatalErrors
		if (!fatal) return
		const error = sanitizeFatalError(value)
		try {
			await bounded(async() => {
				await Promise.all([
					(async() => {
						try {
							await beginDrain('error')
							await shutdown('error')
						} catch { /* termination remains mandatory */ }
					})(),
					(async() => {
						try { await fatal.onFatalError?.(error, type) } catch { /* isolated diagnostics */ }
					})()
				])
			}, fatal.timeoutMs)
		} catch { /* bounded fatal cleanup deliberately proceeds to termination */ }
		try { await fatal.terminate(1) } catch { /* the library never substitutes process.exit() */ }
	}
	let fatalStarted = false
	const handleFatal = (value: unknown, type: NodeFatalErrorType): void => {
		if (fatalStarted) return
		fatalStarted = true
		void runFatal(value, type)
	}
	const uncaughtException = (error: Error): void => { handleFatal(error, 'uncaughtException') }
	const unhandledRejection = (reason: unknown): void => { handleFatal(reason, 'unhandledRejection') }

	let removeCleanup: LifecycleHookDisposer | undefined
	const dispose = (): void => {
		if (!active) return
		active = false
		let listenerCleanupFailed = false
		for (const [signal, listener] of signalListeners) {
			try { process.off(signal, listener) } catch { listenerCleanupFailed = true }
		}
		if (captured.fatalErrors) {
			try { process.off('uncaughtException', uncaughtException) } catch { listenerCleanupFailed = true }
			try { process.off('unhandledRejection', unhandledRejection) } catch { listenerCleanupFailed = true }
		}
		try { removeCleanup?.() } catch { /* ownership must still be released */ }
		removeCleanup = undefined
		if (listenerCleanupFailed) {
			active = true
			runtimeOwner.retryCleanup = dispose
			throw new Error('LIFECYCLE_NODE_LISTENER_CLEANUP_FAILED')
		}
		delete runtimeOwner.retryCleanup
		if (owner === runtimeOwner) owner = undefined
	}
	try {
		for (const signal of captured.signals) {
			const listener = (): void => {
				// Admission must close in the signal callback itself; deferring
				// beginDrain leaves readiness green for the rest of this turn.
				let draining: Promise<void>
				try { draining = Promise.resolve(beginDrain('signal')) } catch {
					draining = Promise.resolve()
				}
				void draining
					.catch(() => undefined)
					.then(async() => await shutdown('signal'))
					.catch(() => undefined)
			}
			signalListeners.set(signal, listener)
			process.on(signal, listener)
		}
		if (captured.fatalErrors) {
			process.on('uncaughtException', uncaughtException)
			process.on('unhandledRejection', unhandledRejection)
		}
		removeCleanup = attachLifecycleCleanup(lifecycle, dispose)
			?? registerShutdownHook(
				'http-server',
				() => dispose(),
				{name: 'lifecycle-node-listeners', priority: -10_000}
			)
	} catch(error) {
		dispose()
		throw error
	}
	return dispose
}
