import {readFileSync} from 'node:fs'

import {describe, it, expect} from 'vitest'

import {createContainer} from '../src/index'
import {TOK} from '../src/tokens'

describe('core foundation', () => {
	it('keeps publish artifacts clean and rebuilds immediately before packing', () => {
		const manifest = JSON.parse(readFileSync(
			new URL('../package.json', import.meta.url), 'utf8'
		)) as {files?: string[]; scripts?: Record<string, string>}

		expect(manifest.files).toContain('dist')
		expect(manifest.files).toContain('!dist/**/* 2*')
		expect(manifest.scripts?.prepack).toBe('pnpm build')
	})

	it('binds and resolves services through stable tokens', () => {
		const container = createContainer()
		const clock = {now: () => 123}

		container.bind(TOK.Clock, clock)

		expect(container.get<typeof clock>(TOK.Clock)).toBe(clock)
		expect(container.tryGet<typeof clock>(TOK.Clock)).toBe(clock)
		expect(container.has(TOK.Clock)).toBe(true)
	})

	it('keeps optional ports absent until an application provides them', () => {
		const container = createContainer()

		expect(container.tryGet(TOK.Errors)).toBeUndefined()
		expect(container.tryGet(TOK.Logging)).toBeUndefined()
	})

	it('keeps the lifecycle token globally stable across package boundaries', () => {
		expect(TOK.Lifecycle).toBe(Symbol.for('@ooopsstudio/lifecycle'))
	})

	it('keeps the profiling token globally stable across package boundaries', () => {
		expect(TOK.Profiling).toBe(Symbol.for('@ooopsstudio/profiling'))
		expect(TOK.Performance).toBe(Symbol.for('@ooopsstudio/performance'))
		expect(TOK.Audit).toBe(Symbol.for('@ooopsstudio/audit'))
		expect(TOK.AuditAdmin).toBe(Symbol.for('@ooopsstudio/audit-admin'))
		expect(TOK.AuditTransactional).toBe(Symbol.for('@ooopsstudio/audit-transactional'))
		expect(TOK.Cache).toBe(Symbol.for('@ooopsstudio/cache'))
		expect(TOK.RateLimit).toBe(Symbol.for('@ooopsstudio/ratelimit'))
		expect(TOK.Resilience).toBe(Symbol.for('@ooopsstudio/resilience'))
		expect('Redis' in TOK).toBe(false)
	})
})
