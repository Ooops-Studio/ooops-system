/**
 * @file Tests for resource detector.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'

import {detectResource} from '../../../src/features/resources/resource-detector'

describe('detectResource', () => {

	const originalEnv = process.env

	beforeEach(() => {

		vi.resetModules()
		process.env = {...originalEnv}
	})

	afterEach(() => {

		process.env = originalEnv
	})

	it('should detect resource with provided options', () => {

		const resource = detectResource({
			serviceName: 'test-service',
			serviceVersion: '1.0.0',
			deploymentEnvironment: 'test',
			hostName: 'test-host',
			processPid: 12345,
			runtimeType: 'nodejs',
			runtimeVersion: 'v20.0.0'
		})

		expect(resource['service.name']).toBe('test-service')
		expect(resource['service.version']).toBe('1.0.0')
		expect(resource['deployment.environment']).toBe('test')
		expect(resource['host.name']).toBe('test-host')
		expect(resource['process.pid']).toBe(12345)
		expect(resource['runtime.type']).toBe('nodejs')
		expect(resource['runtime.version']).toBe('v20.0.0')
	})

	it('should detect resource from environment variables', () => {

		process.env.SERVICE_NAME = 'env-service'
		process.env.SERVICE_VERSION = '2.0.0'
		process.env.NODE_ENV = 'production'

		const resource = detectResource({})

		expect(resource['service.name']).toBe('env-service')
		expect(resource['service.version']).toBe('2.0.0')
		expect(resource['deployment.environment']).toBe('production')
	})

	it('should prioritize options over environment variables', () => {

		process.env.SERVICE_NAME = 'env-service'
		process.env.SERVICE_VERSION = '2.0.0'

		const resource = detectResource({
			serviceName: 'option-service',
			serviceVersion: '3.0.0'
		})

		expect(resource['service.name']).toBe('option-service')
		expect(resource['service.version']).toBe('3.0.0')
	})

	it('rejects unsafe explicit resource metadata and ignores unsafe environment values', () => {
		expect(() => detectResource({serviceName: ''})).toThrow('serviceName')
		expect(() => detectResource({processPid: -1})).toThrow('processPid')
		process.env.SERVICE_NAME = 'x'.repeat(300)
		expect(detectResource({})['service.name']).toBeUndefined()
	})

	it('rejects accessor-backed and unexpected resource options without invoking getters', () => {
		let getterCalls = 0
		const accessor = Object.defineProperty({}, 'serviceName', {
			enumerable: true,
			get: () => { getterCalls++; return 'api' }
		})
		expect(() => detectResource(accessor as never)).toThrow('closed plain data object')
		expect(() => detectResource({serviceName: 'api', typo: 'value'} as never)).toThrow('closed plain data object')
		expect(getterCalls).toBe(0)
	})

	it('should detect host name from os module', () => {

		const resource = detectResource({})

		// Should have host.name if os module is available
		if (typeof require !== 'undefined') {
			expect(resource['host.name']).toBeDefined()
		}
	})

	it('should detect process PID', () => {

		const resource = detectResource({})

		if (process.pid) {
			expect(resource['process.pid']).toBe(process.pid)
		}
	})

	it('should default runtime type to nodejs', () => {

		const resource = detectResource({})

		expect(resource['runtime.type']).toBe('nodejs')
	})

	it('should detect runtime version from process.version', () => {

		const resource = detectResource({})

		if (process.version) {
			expect(resource['runtime.version']).toBe(process.version)
		}
	})

	it('should handle missing environment variables', () => {

		delete process.env.SERVICE_NAME
		delete process.env.SERVICE_VERSION
		delete process.env.NODE_ENV

		const resource = detectResource({})

		expect(resource['service.name']).toBeUndefined()
		expect(resource['service.version']).toBeUndefined()
		expect(resource['deployment.environment']).toBeUndefined()
		expect(resource['runtime.type']).toBe('nodejs')
	})

	it('should omit runtime defaults when process does not look like Node', () => {

		const originalRelease = process.release
		const originalVersion = process.version

		Object.defineProperty(process, 'release', {
			value: undefined,
			configurable: true
		})
		Object.defineProperty(process, 'version', {
			value: '',
			configurable: true
		})

		const resource = detectResource({})

		expect(resource['runtime.type']).toBeUndefined()
		expect(resource['runtime.version']).toBeUndefined()

		Object.defineProperty(process, 'release', {
			value: originalRelease,
			configurable: true
		})
		Object.defineProperty(process, 'version', {
			value: originalVersion,
			configurable: true
		})
	})
})
