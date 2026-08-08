import {describe, expect, it} from 'vitest'

import {isPublicNetworkAddress} from '../../src/utils/public-network-address'

describe('public network address classification', () => {
	it.each([
		'0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
		'172.16.0.1', '192.88.99.2', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
		'::', '::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '64:ff9b:1::1',
		'100:0:0:1::1', '3fff::1', '5f00::1',
		'4000::1', '8000::1', 'f000::1',
		'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1'
	])('rejects non-public address %s', (address) => {
		expect(isPublicNetworkAddress(address)).toBe(false)
	})

	it.each([
		'1.1.1.1', '8.8.8.8', '203.0.114.10',
		'2001:4860:4860::8888', '2606:4700:4700::1111'
	])('accepts public address %s', (address) => {
		expect(isPublicNetworkAddress(address)).toBe(true)
	})
})
