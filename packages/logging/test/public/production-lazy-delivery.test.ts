import {describe, expect, it, vi} from 'vitest'

import {createProductionLogging} from '../../src/public/production'

describe('production lazy remote delivery', () => {
	it('delivers through the dynamically loaded remote pipeline', async() => {
		const lines: string[] = []
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		try {
			const logger = await createProductionLogging({
				clock: {now: () => 1_000},
				selfMetrics: false,
				remote: {provider: 'custom', sink: {write: (line) => { lines.push(line) }}}
			})
			logger.info('remote-lazy-delivery')
			await logger.flush()
			expect(lines).toHaveLength(1)
			expect(lines[0]).toContain('remote-lazy-delivery')
			await logger.shutdown()
		} finally {
			stdout.mockRestore()
		}
	})
})
