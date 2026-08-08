import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

describe('shared observability contract', () => {
	it('uses ObservabilityResource without profiling-specific aliases', () => {
		const source = readFileSync(new URL('../../src/contracts/observability-shared.ts', import.meta.url), 'utf8')
		expect(source).toContain('interface ObservabilityResource')
		for (const removed of ['ProfilingProfileKind', 'ProfilingResource', 'ProfilingLifecycleHooks']) {
			expect(source).not.toContain(removed)
		}
	})
})
