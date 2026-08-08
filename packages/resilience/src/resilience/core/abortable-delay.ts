import {isolateUnexpectedThenable} from '../utils/capabilities'

import {MAX_TIMER_DELAY_MS} from './timer-limits'

const createAbortError = () => Object.assign(new Error('Operation aborted'), {name: 'AbortError', code: 'ABORT_ERR'})

export async function waitForAbortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return
	if (!Number.isFinite(delayMs) || delayMs > MAX_TIMER_DELAY_MS) throw new Error(`[Resilience] delay must not exceed ${MAX_TIMER_DELAY_MS}`)
	if (signal?.aborted) throw createAbortError()
	await new Promise<void>((resolve, reject) => {
		let settled = false
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		const removeAbortListener = () => {
			try { isolateUnexpectedThenable(signal?.removeEventListener?.('abort', onAbort)) } catch { /* cleanup is best effort */ }
		}
		const clearTimer = () => { try { if (timeoutId !== undefined) clearTimeout(timeoutId) } catch { /* cleanup is best effort */ } }
		const onAbort = () => {
			if (settled) return
			settled = true
			clearTimer()
			removeAbortListener()
			reject(createAbortError())
		}
		try { timeoutId = setTimeout(() => {
			if (settled) return
			settled = true
			removeAbortListener()
			resolve()
		}, delayMs) } catch(error) { reject(error); return }
		if (settled) return
		if (signal) {
			try {
				if (isolateUnexpectedThenable(signal.addEventListener('abort', onAbort, {once: true}))) {
					throw new Error('[Resilience] AbortSignal.addEventListener must complete synchronously')
				}
				if (signal.aborted) onAbort()
			} catch(error) {
				clearTimer()
				removeAbortListener()
				reject(error)
			}
		}
	})
}
