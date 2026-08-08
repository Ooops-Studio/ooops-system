import {spawn} from 'node:child_process'

import {describe, expect, it} from 'vitest'

describe('Jobs awaited timers', () => {
	it('keeps Node alive while a bounded backend stage owns physical work', async() => {
		const script = String.raw`
			import {createCustomJobs} from './dist/custom.js'
			import {createMemoryJobsBackend} from './dist/custom/backends/memory.js'
			const memory = createMemoryJobsBackend()
			const backend = {
				...memory,
				schedules: {...memory.schedules, triggerDueSchedules: async () => await new Promise(() => undefined)}
			}
			const runtime = await createCustomJobs({clock: {now: () => 0}, backend})
			void runtime.jobs.start()
			console.log('stage-started')
		`
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			cwd: new URL('../../', import.meta.url),
			stdio: ['ignore', 'pipe', 'pipe']
		})
		let output = ''
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child readiness. Output: ${output}`)), 2_000)
				const finish = (callback: () => void) => {
					clearTimeout(timeout)
					child.off('error', onError)
					child.off('exit', onExit)
					callback()
				}
				const onError = (error: Error) => finish(() => reject(error))
				const onExit = (code: number | null, signal: string | null) => {
					finish(() => reject(new Error(`Child exited before readiness (code=${code}, signal=${signal}). Output: ${output}`)))
				}

				child.on('error', onError)
				child.on('exit', onExit)
				child.stdout.on('data', (chunk: Buffer) => {
					output += chunk.toString()
					if (output.includes('stage-started')) finish(resolve)
				})
			})
			expect(child.exitCode).toBeNull()
		} finally {
			if (child.exitCode === null) child.kill('SIGTERM')
			if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()))
		}
	})
})
