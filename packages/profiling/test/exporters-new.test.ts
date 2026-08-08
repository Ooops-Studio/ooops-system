import type {CpuProfileArtifact} from '@ooopsstudio/core/ports/profiling'
import {describe, expect, it, vi} from 'vitest'

import {createConsoleProfileExporter} from '../src/console-exporter'
import {createMemoryProfileExporter} from '../src/memory-exporter'

const profile: CpuProfileArtifact = {type: 'cpu', format: 'cpuprofile', name: 'safe', startedAt: 1, endedAt: 2, durationMs: 1, captured: true, payload: 'secret-profile-payload', resource: {}}

describe('explicit profiling exporters', () => {
	it('console emits metadata but not payload', async() => {
		const log = vi.fn(); await createConsoleProfileExporter({log} as never).export(profile)
		expect(log).toHaveBeenCalledOnce(); expect(log.mock.calls[0]?.[0]).not.toContain(profile.payload)
	})
	it('rejects console accessors without executing them and awaits asynchronous writes', async() => {
		let reads = 0
		const accessor = Object.defineProperty({}, 'log', {get() { reads++; return vi.fn() }})
		expect(() => createConsoleProfileExporter(accessor as never)).toThrow('profiling_invalid_console')
		expect(reads).toBe(0)
		const failure = new Error('authorization=secret-console-write')
		const exporter = createConsoleProfileExporter({log: async() => await Promise.reject(failure)} as never)
		await expect(exporter.export(profile)).rejects.toThrow(/^profiling_console_write_failure$/u)
		await expect(exporter.export(profile)).rejects.not.toThrow('secret-console-write')
	})
	it('memory storage is bounded, cloned and cleared on shutdown', async() => {
		const exporter = createMemoryProfileExporter({maxProfiles: 1, maxBytes: 1024})
		await exporter.export(profile); await exporter.export({...profile, name: 'second'})
		expect(exporter.getProfiles()).toHaveLength(1); expect(exporter.getDroppedCount()).toBe(1)
		await exporter.shutdown?.(); expect(exporter.getProfiles()).toEqual([])
	})
	it('memory exporter drops hostile resources without exposing raw failures', async() => {
		const exporter = createMemoryProfileExporter({maxBytes: 1024})
		const hostileResource = new Proxy({}, {
			ownKeys() { throw new Error('authorization=secret-resource') }
		})
		await expect(exporter.export({...profile, resource: hostileResource as never})).resolves.toBeUndefined()
		expect(exporter.getDroppedCount()).toBe(1)
	})
	it('memory exporter sanitizes resource secrets and PII before storage', async() => {
		const exporter = createMemoryProfileExporter({maxBytes: 1024})
		await exporter.export({...profile, resource: {
			'service.name': 'operator@example.com',
			authorization: 'Bearer secret-token'
		}})
		expect(exporter.getProfiles()[0]?.resource).toEqual({
			'service.name': '[email]',
			authorization: 'redacted'
		})
	})
	it('rejects oversized payloads before traversing artifact metadata', async() => {
		const exporter = createMemoryProfileExporter({maxBytes: 8})
		const byteLength = vi.spyOn(Buffer, 'byteLength')
		let resourceReads = 0
		const hostileResource = new Proxy({}, {
			ownKeys() { resourceReads++; throw new Error('must not inspect') }
		})
		await expect(exporter.export({...profile, payload: 'payload-too-large', resource: hostileResource as never})).resolves.toBeUndefined()
		expect(resourceReads).toBe(0)
		expect(byteLength.mock.calls.some(([value]) => value === 'payload-too-large')).toBe(false)
		byteLength.mockRestore()
		expect(exporter.getDroppedCount()).toBe(1)
	})
	it('enforces UTF-8 memory limits with a rewired global Buffer', async() => {
		vi.stubGlobal('Buffer', {byteLength: () => 0})
		try {
			const exporter = createMemoryProfileExporter({maxBytes: 2})
			await exporter.export({...profile, payload: '€'})
			expect(exporter.getProfiles()).toEqual([])
			expect(exporter.getDroppedCount()).toBe(1)
		} finally { vi.unstubAllGlobals() }
	})
	it('does not trust a rewired global JSON serializer for memory accounting', async() => {
		const exporter = createMemoryProfileExporter({maxBytes: 8})
		vi.stubGlobal('JSON', {stringify: () => '{}'})
		try { await exporter.export({...profile, payload: 'x'}) } finally { vi.unstubAllGlobals() }
		expect(exporter.getProfiles()).toEqual([])
		expect(exporter.getDroppedCount()).toBe(1)
	})
	it('does not execute artifact accessors in standalone exporters', async() => {
		let reads = 0
		const hostile = Object.defineProperty({...profile}, 'payload', {
			enumerable: true,
			get() { reads++; throw new Error('authorization=secret-accessor') }
		})
		const log = vi.fn()
		await expect(createConsoleProfileExporter({log} as never).export(hostile)).rejects.toThrow('profiling_invalid_console_profile')
		const memory = createMemoryProfileExporter({maxBytes: 1024})
		await expect(memory.export(hostile)).resolves.toBeUndefined()
		expect(memory.getDroppedCount()).toBe(1)
		expect(reads).toBe(0)
	})
	it('does not store a profile when hostile snapshot work re-enters shutdown', async() => {
		const memory = createMemoryProfileExporter({maxBytes: 1024})
		let stopped = false
		const hostile = new Proxy({...profile}, {
			getOwnPropertyDescriptor(target, key) {
				if (!stopped) { stopped = true; void memory.shutdown?.() }
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
		await memory.export(hostile)
		expect(memory.getProfiles()).toEqual([])
		expect(memory.getDroppedCount()).toBe(1)
	})
})
