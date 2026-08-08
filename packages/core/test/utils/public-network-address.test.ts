import {BlockList} from 'node:net'

import {describe, expect, it} from 'vitest'

import {isPublicNetworkAddress} from '../../src/utils/public-network-address'

describe('public network address classification', () => {
	it.each([
		'0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
		'172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
		'::', '::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'fc00::1', 'fe80::1', 'ff02::1'
	])('rejects non-public address %s', (address) => {
		expect(isPublicNetworkAddress(address)).toBe(false)
	})

	it.each(['1.1.1.1', '8.8.8.8', '203.0.114.10', '2001:4860:4860::8888'])(
		'accepts public address %s', (address) => {
			expect(isPublicNetworkAddress(address)).toBe(true)
		}
	)

	it('preserves SSRF classification when BlockList.prototype.check is replaced', () => {
		const descriptor = Object.getOwnPropertyDescriptor(BlockList.prototype, 'check')!
		let privateResult: boolean
		let publicResult: boolean
		try {
			Object.defineProperty(BlockList.prototype, 'check', {
				configurable: true,
				writable: true,
				value: () => false
			})
			privateResult = isPublicNetworkAddress('127.0.0.1')
			publicResult = isPublicNetworkAddress('1.1.1.1')
		} finally {
			Object.defineProperty(BlockList.prototype, 'check', descriptor)
		}

		expect(privateResult!).toBe(false)
		expect(publicResult!).toBe(true)
	})

	it('rejects oversized and non-string runtime input before native parsing', () => {
		expect(isPublicNetworkAddress('1'.repeat(1_000_000))).toBe(false)
		expect(isPublicNetworkAddress({toString: () => '1.1.1.1'} as never)).toBe(false)
	})
})
