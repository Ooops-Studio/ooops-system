import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

const readAuditSource = (path: string) => readFileSync(
	new URL(`../../src/audit/${path}`, import.meta.url),
	'utf8'
)

describe('audit entry boundaries', () => {
	it('imports every built public audit subpath', async() => {
		const [root, development, production, custom, admin, observability, types] = await Promise.all([
			import(new URL('../../dist/index.js', import.meta.url).href),
			import(new URL('../../dist/development.js', import.meta.url).href),
			import(new URL('../../dist/production.js', import.meta.url).href),
			import(new URL('../../dist/custom.js', import.meta.url).href),
			import(new URL('../../dist/admin.js', import.meta.url).href),
			import(new URL('../../dist/observability.js', import.meta.url).href),
			import(new URL('../../dist/public/types.js', import.meta.url).href)
		])
		expect(root.registerAudit).toBeTypeOf('function')
		expect(development.createDevelopmentAudit).toBeTypeOf('function')
		expect(production.createProductionAudit).toBeTypeOf('function')
		expect(custom.createCustomAudit).toBeTypeOf('function')
		expect(Object.keys(admin)).toEqual([])
		expect(observability.attachAuditObservability).toBeTypeOf('function')
		expect(Object.keys(types)).toEqual([])
	})

	it('publishes only the intentional audit package surface', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			exports: Record<string, unknown>
		}
		expect(Object.keys(manifest.exports)).toEqual([
			'.', './development', './production', './custom', './admin', './observability', './public/types'
		])
	})

	it('keeps legacy lifecycle and detailed status members out of declarations', () => {
		const core = readFileSync(new URL('../../../core/dist/ports/audit.d.ts', import.meta.url), 'utf8')
		const contracts = readFileSync(new URL('../../../core/dist/contracts/audit.d.ts', import.meta.url), 'utf8')
		for (const removed of ['destroy(', 'storeKind', 'lastRecordAt', 'lastVerificationAt', 'lastFinalizationError']) {
			expect(core).not.toContain(removed)
		}
		expect(contracts).not.toContain('AuditRecordFieldValue')
		expect(core).toContain('interface TransactionalAuditPort')
		expect(core).toContain('interface ManagedAudit')
	})

	it('keeps root preset registration dynamically loaded', () => {
		const source = readAuditSource('index.ts')
		expect(source).toContain("await import('./public/development')")
		expect(source).toContain("await import('./public/production')")
		expect(source).toContain("await import('./public/custom')")
		expect(source).not.toMatch(/^import \{[^}]*create(?:Development|Production|Custom)Audit/m)
	})

	it('keeps PostgreSQL verification and retention out of the normal store graph', () => {
		const source = readAuditSource('features/stores/postgres-store.ts')
		const retention = readAuditSource('features/stores/postgres-retention.ts')
		expect(source).toContain("import('./postgres-verification')")
		expect(source).toContain("import('./postgres-retention')")
		expect(source).not.toMatch(/^import \{[^}]*\} from '\.\/postgres-(?:verification|retention)'/m)
		expect(source).not.toContain('retention records')
		expect(retention).toContain('retention records')
	})

	it('keeps custom-only policy and archive code out of the standard handler', () => {
		const source = readAuditSource('core/standard-handler.ts')
		expect(source).not.toContain('custom-handler')
		expect(source).not.toContain('custom-options')
		expect(source).not.toContain('admin-archive')
		expect(source).not.toContain('Tracing')
		expect(source).not.toContain('AuditArchiveSink')
	})

	it('routes standard presets and custom through separate composition handlers', () => {
		const development = readAuditSource('public/development.ts')
		const production = readAuditSource('public/production.ts')
		const custom = readAuditSource('public/custom.ts')

		expect(development).toContain("from '../core/standard-handler'")
		expect(production).toContain("from '../core/standard-handler'")
		expect(development).not.toContain('custom-handler')
		expect(production).not.toContain('custom-handler')
		expect(custom).toContain("from '../core/custom-handler'")
		expect(custom).not.toContain('standard-handler')
	})

	it('keeps admin implementation behind a lazy runtime boundary', () => {
		const runtime = readAuditSource('core/handler.ts')
		const lazyAdmin = readAuditSource('core/lazy-admin.ts')

		expect(runtime).toContain("from './lazy-admin'")
		expect(runtime).not.toMatch(/^import \{[^}]*createAuditAdmin[^}]*\} from '\.\/admin'/m)
		expect(lazyAdmin).toContain("import('./admin')")
	})
})
