import {describe, expect, it} from 'vitest'

import {createInspectorProfiler} from '../../src/profilers-inspector'

describe('real Node Inspector integration', () => {
	it('captures a bounded parseable CPU profile and releases the session', async() => {
		const profiler = createInspectorProfiler({maxPayloadBytes: 4 * 1024 * 1024})
		const first = await profiler.capture({type: 'cpu', durationMs: 5})
		const payload = JSON.parse(first.payload) as {nodes?: unknown[]}

		expect(first).toMatchObject({type: 'cpu', format: 'cpuprofile', captured: true})
		expect(payload.nodes).toBeInstanceOf(Array)

		await expect(profiler.capture({type: 'cpu', durationMs: 5}))
			.resolves.toMatchObject({captured: true})
	})
})
