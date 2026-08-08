import {describe, expect, it, vi} from 'vitest'

import {observabilityResourceToMetricLabels} from '../../src/public/observability'

describe('metrics public observability helpers', () => {
	it('returns empty labels when no resource is provided', () => {
		expect(observabilityResourceToMetricLabels()).toEqual({})
	})

	it('maps only defined observability resource fields to metric labels', () => {
		expect(observabilityResourceToMetricLabels({
			serviceName: 'flop',
			serviceVersion: '1.2.3',
			deploymentEnvironment: 'production',
			hostKind: 'studio',
			runtime: 'node'
		})).toEqual({
			service_name: 'flop',
			service_version: '1.2.3',
			deployment_environment: 'production',
			host_kind: 'studio',
			runtime: 'node'
		})

		expect(observabilityResourceToMetricLabels({
			serviceName: 'flop'
		})).toEqual({
			service_name: 'flop'
		})
	})

	it('rejects malformed and accessor-backed resources without invoking getters', () => {
		const getter = vi.fn(() => 'secret')
		const resource = Object.defineProperty({}, 'serviceName', {enumerable: true, get: getter})

		expect(() => observabilityResourceToMetricLabels(resource as never)).toThrow('data field')
		expect(getter).not.toHaveBeenCalled()
		expect(() => observabilityResourceToMetricLabels({serviceName: ''})).toThrow('non-empty')
		expect(() => observabilityResourceToMetricLabels({
			serviceName: 'service', serviceVersion: 1 as never
		})).toThrow('serviceVersion must be a string')
	})
})
