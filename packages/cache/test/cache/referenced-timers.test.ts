import {spawn} from 'node:child_process'

import {describe, expect, it} from 'vitest'

describe('cache awaited timers', () => {
	it('keeps Node alive while bounded shutdown is awaiting physical work', async() => {
		const script = String.raw`
			import {createCustomCache} from './dist/custom.js'
			const backend = {
				get: async () => undefined,
				getMany: async () => new Map(),
				set: async () => undefined,
				setMany: async () => undefined,
				delete: async () => 0,
				invalidate: async () => 0,
				shutdown: async () => await new Promise(() => undefined)
			}
			const cache = createCustomCache({backend, clock: {now: () => 0}})
			void cache.shutdown()
			console.log('shutdown-started')
		`
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			cwd: new URL('../../', import.meta.url),
			stdio: ['ignore', 'pipe', 'pipe']
		})
		let output = ''
		let errorOutput = ''
		child.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString() })

		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					finish(() => reject(new Error(`child did not start shutdown within 5 seconds: ${errorOutput}`)))
				}, 5_000)
				const onData = (chunk: Buffer) => {
					output += chunk.toString()
					if (output.includes('shutdown-started')) finish(resolve)
				}
				const onError = (error: Error) => finish(() => reject(error))
				const onExit = (code: number | null, signal: string | null) => {
					finish(() => reject(new Error(`child exited before shutdown started (${code ?? signal}): ${errorOutput}`)))
				}
				const finish = (callback: () => void) => {
					clearTimeout(timeout)
					child.stdout.off('data', onData)
					child.off('error', onError)
					child.off('exit', onExit)
					callback()
				}

				child.stdout.on('data', onData)
				child.once('error', onError)
				child.once('exit', onExit)
			})
			expect(child.exitCode).toBeNull()
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
				child.kill('SIGTERM')
				await exited
			}
		}
	})
})
