/**
 * Console sink: writes to stdout/stderr with a tiny level heuristic.
 * Works with JSON and pretty lines. Sink failures are allowed to propagate to
 * the transferring stage, which keeps public logger writes non-throwing while
 * making explicit flush/close diagnostics honest.
 */
import type {LogLevel} from '@ooopsstudio/core/contracts/logging'

import type {Sink} from '../../types/sink'
import {captureLoggingMethod} from '../../utils/capabilities'

export interface ConsoleSinkOptions {
	/** Levels routed to stderr (default: warn,error,fatal). */
	readonly stderrLevels?: ReadonlySet<LogLevel>
	/** Fixed stream routing for protocol-oriented hosts. */
	readonly stream?: 'split' | 'stdout' | 'stderr'
}

const DEFAULT_STDERR = new Set<LogLevel>(['warn', 'error', 'fatal'])
const LOG_LEVELS = new Set<LogLevel>(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu')

/**
 * Detect whether the runtime exposes a Node-like `process` global.
 */
const hasProcess = (): boolean => typeof process !== 'undefined' && process !== null

/**
 * Write to stdout/stderr with graceful fallbacks so this sink works in browsers too.
 */
function extractLevel(line: string): LogLevel | undefined {
	// Structured JSON must use only the top-level severity. A regex can be
	// spoofed by an earlier nested `attributes.level` or message fragment.
	if (line.trimStart().startsWith('{')) {
		try {
			const parsed = JSON.parse(line) as {level?: unknown}
			const level = parsed && typeof parsed === 'object' ? parsed.level : undefined
			if (typeof level === 'string' && LOG_LEVELS.has(level as LogLevel)) {
				return level as LogLevel
			}
		} catch {
			// Fall through to the human-readable format heuristics.
		}
	}
	const plainLine = line.replace(ANSI_ESCAPE_SEQUENCE, '')
	// Legacy pretty: [warn] ...; current pretty: <timestamp> WARN ...
	const mPretty = /^\s*\[(trace|debug|info|warn|error|fatal)\]/i.exec(plainLine)
	if (mPretty && mPretty[1]) return mPretty[1].toLowerCase() as LogLevel
	const mCurrentPretty = /^\S+\s+(trace|debug|info|warn|error|fatal)\b/i.exec(plainLine)
	if (mCurrentPretty && mCurrentPretty[1]) return mCurrentPretty[1].toLowerCase() as LogLevel
	return undefined
}

export function consoleSink(opts: ConsoleSinkOptions = {}): Sink<string> {
	const stream = opts.stream ?? 'split'
	if (stream !== 'split' && stream !== 'stdout' && stream !== 'stderr') {
		throw new TypeError('Logging console stream must be split, stdout, or stderr')
	}
	const stderrLevels = stream === 'stderr' ? LOG_LEVELS
		: stream === 'stdout' ? new Set<LogLevel>()
			: opts.stderrLevels ?? DEFAULT_STDERR
	const stdout = hasProcess() ? process.stdout : undefined
	const stderr = hasProcess() ? process.stderr : undefined
	const stdoutWrite = captureLoggingMethod<(payload: string) => boolean>(stdout, 'write')
	const stderrWrite = captureLoggingMethod<(payload: string) => boolean>(stderr, 'write')
	const stdoutOnce = captureLoggingMethod<(event: string, callback: (...args: unknown[]) => void) => unknown>(stdout, 'once')
	const stderrOnce = captureLoggingMethod<(event: string, callback: (...args: unknown[]) => void) => unknown>(stderr, 'once')
	const stdoutRemoveListener = captureLoggingMethod<(event: string, callback: (...args: unknown[]) => void) => unknown>(stdout, 'removeListener')
	const stderrRemoveListener = captureLoggingMethod<(event: string, callback: (...args: unknown[]) => void) => unknown>(stderr, 'removeListener')
	const fallbackLog = console.log.bind(console)
	const fallbackError = console.error.bind(console)
	const pendingDrains: Partial<Record<'stdout' | 'stderr', Promise<void>>> = {}
	const writeToStdStream = (stream: 'stdout' | 'stderr', payload: string): void | Promise<void> => {
		const pending = pendingDrains[stream]
		if (pending) return pending.then(() => writeToStdStream(stream, payload))
		const target = stream === 'stderr' ? stderr : stdout
		const write = stream === 'stderr' ? stderrWrite : stdoutWrite
		const once = stream === 'stderr' ? stderrOnce : stdoutOnce
		const removeListener = stream === 'stderr' ? stderrRemoveListener : stdoutRemoveListener
		if (target && write) {
			const result: unknown = write.call(target, payload)
			if (captureLoggingMethod(result, 'then')) {
				return Promise.resolve(result).then(() => undefined)
			}
			if (result !== false) return
			const drain = new Promise<void>((resolve, reject) => {
				if (!once) throw new Error(`Logging ${stream} stream cannot signal backpressure drain`)
				// Minimal stream shims may expose only `once`; in that case retain the
				// legacy drain-only behavior. Real Node streams expose removeListener,
				// which lets us safely observe terminal events without leaking listeners.
				if (!removeListener) {
					once.call(target, 'drain', () => resolve())
					return
				}
				let settled = false
				const cleanup = (): void => {
					for (const [event, listener] of [
						['drain', onDrain], ['error', onError], ['close', onClose]
					] as const) {
						try { removeListener.call(target, event, listener) } catch { /* Cleanup is best-effort. */ }
					}
				}
				const finish = (error?: unknown): void => {
					if (settled) return
					settled = true
					cleanup()
					if (error === undefined) resolve()
					else reject(error)
				}
				const onDrain = (): void => finish()
				const onError = (error: unknown): void => finish(error)
				const onClose = (): void => finish(new Error(`Logging ${stream} stream closed before backpressure drained`))
				try {
					once.call(target, 'drain', onDrain)
					if (settled) return
					once.call(target, 'error', onError)
					if (settled) return
					once.call(target, 'close', onClose)
				} catch(error) {
					finish(error)
				}
			}).finally(() => {
				if (pendingDrains[stream] === drain) delete pendingDrains[stream]
			})
			pendingDrains[stream] = drain
			return drain
		}
		if (stream === 'stderr') fallbackError(payload.trimEnd())
		else fallbackLog(payload.trimEnd())
	}
	return {
		write(line: string): void | Promise<void> {
			const lvl = extractLevel(line)
			if (lvl && stderrLevels.has(lvl)) {
				return writeToStdStream('stderr', `${line}\n`)
			}
			return writeToStdStream('stdout', `${line}\n`)
		},
		writeBatch(lines: readonly string[]): void | Promise<void> {
			/* v8 ignore next -- defensive or compatibility path not constructible through the public logging API */
			if (lines.length === 0) return

			const stderrLines: string[] = []
			const stdoutLines: string[] = []

			for (const line of lines) {
				const lvl = extractLevel(line)
				if (lvl && stderrLevels.has(lvl)) {
					stderrLines.push(line)
				} else {
					stdoutLines.push(line)
				}
			}

			const writes: Array<void | Promise<void>> = []
			if (stdoutLines.length > 0) writes.push(writeToStdStream('stdout', `${stdoutLines.join('\n')}\n`))
			if (stderrLines.length > 0) writes.push(writeToStdStream('stderr', `${stderrLines.join('\n')}\n`))
			if (writes.some((write) => write instanceof Promise)) return Promise.all(writes).then(() => undefined)
		},
		async flush() {},
		async close() {}
	}
}
