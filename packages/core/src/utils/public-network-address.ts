import {BlockList, isIP} from 'node:net'

import {containNativePromiseUnchecked} from '../runtime/async/native-promise'

const nativeBlockListCheck = BlockList.prototype.check
const nativeReflectApply = Reflect.apply
const nonPublicIpv4Addresses = new BlockList()
const nonPublicIpv6Addresses = new BlockList()
const publicIpv6Addresses = new BlockList()

publicIpv6Addresses.addSubnet('2000::', 3, 'ipv6')

for (const [address, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
	['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
	['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
	['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) nonPublicIpv4Addresses.addSubnet(address, prefix, 'ipv4')

for (const [address, prefix] of [
	['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
	['100::', 64], ['100:0:0:1::', 64], ['2001::', 23], ['2001:db8::', 32],
	['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7],
	['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
] as const) nonPublicIpv6Addresses.addSubnet(address, prefix, 'ipv6')

/** Classify globally routable IPv4/IPv6 literals for SSRF-safe clients. */
export function isPublicNetworkAddress(address: string): boolean {
	containNativePromiseUnchecked(address)
	// The longest accepted textual IPv6 literal is far below this ceiling. Reject
	// runtime type violations and oversized attacker input before native parsing.
	if (typeof address !== 'string' || address.length === 0 || address.length > 64) return false
	const family = isIP(address)
	if (family === 4) return !(nativeReflectApply(
		nativeBlockListCheck, nonPublicIpv4Addresses, [address, 'ipv4']
	) as boolean)
	if (family === 6) return (nativeReflectApply(
		nativeBlockListCheck, publicIpv6Addresses, [address, 'ipv6']
	) as boolean) && !(nativeReflectApply(
		nativeBlockListCheck, nonPublicIpv6Addresses, [address, 'ipv6']
	) as boolean)
	return false
}
