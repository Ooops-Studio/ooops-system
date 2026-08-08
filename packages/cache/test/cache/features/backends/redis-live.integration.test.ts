import {createConnection} from 'node:net'

import type {CacheRedisPort} from '@ooopsstudio/core/ports/cache'
import {createFixedClock} from '@ooopsstudio/core/runtime/time/fixed-clock'
import {describe, expect, it} from 'vitest'

import {createRedisCacheBackend} from '../../../../src/cache/features/backends/redis'
import {redisCacheDeleteIfValuesScript} from '../../../../src/cache/features/backends/redis-scripts'

type RespValue = string | number | Uint8Array | null | RespValue[]
const port = Number(process.env.CACHE_REDIS_PORT)
const live = describe.runIf(Number.isSafeInteger(port) && port > 0)

function encodeCommand(parts: readonly (string | number | Uint8Array)[]): Buffer {
	const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)]
	for (const part of parts) {
		const bytes = typeof part === 'number' ? Buffer.from(String(part)) : Buffer.from(part)
		chunks.push(Buffer.from(`$${bytes.byteLength}\r\n`), bytes, Buffer.from('\r\n'))
	}
	return Buffer.concat(chunks)
}

function readLine(buffer: Buffer, offset: number): {line: string; offset: number} | undefined {
	const end = buffer.indexOf('\r\n', offset)
	return end < 0 ? undefined : {line: buffer.toString('utf8', offset, end), offset: end + 2}
}

function parseResponse(buffer: Buffer, offset = 0): {value: RespValue; offset: number} | undefined {
	if (offset >= buffer.length) return undefined
	const prefix = String.fromCharCode(buffer[offset]!)
	const line = readLine(buffer, offset + 1)
	if (!line) return undefined
	if (prefix === '+') return {value: line.line, offset: line.offset}
	if (prefix === '-') throw new Error(`Redis error: ${line.line}`)
	if (prefix === ':') return {value: Number(line.line), offset: line.offset}
	if (prefix === '$') {
		const length = Number(line.line)
		if (length === -1) return {value: null, offset: line.offset}
		if (!Number.isSafeInteger(length) || length < 0 || buffer.length < line.offset + length + 2) return undefined
		return {value: new Uint8Array(buffer.subarray(line.offset, line.offset + length)), offset: line.offset + length + 2}
	}
	if (prefix === '*') {
		const length = Number(line.line)
		if (length === -1) return {value: null, offset: line.offset}
		if (!Number.isSafeInteger(length) || length < 0) throw new Error('Redis returned an invalid array length')
		const values: RespValue[] = []
		let next = line.offset
		for (let index = 0; index < length; index++) {
			const parsed = parseResponse(buffer, next)
			if (!parsed) return undefined
			values.push(parsed.value)
			next = parsed.offset
		}
		return {value: values, offset: next}
	}
	throw new Error('Redis returned an unsupported RESP value')
}

function createLiveRedisPort(): CacheRedisPort & {
	command(parts: readonly (string | number | Uint8Array)[]): Promise<RespValue>
} {
	const command = async(parts: readonly (string | number | Uint8Array)[]): Promise<RespValue> => await new Promise(
		(resolve, reject) => {
			const socket = createConnection({host: '127.0.0.1', port})
			const chunks: Buffer[] = []
			let settled = false
			const fail = (error: unknown): void => {
				if (settled) return
				settled = true
				socket.destroy()
				reject(error)
			}
			socket.on('error', fail)
			socket.on('connect', () => socket.write(encodeCommand(parts)))
			socket.on('data', (chunk: Buffer) => {
				chunks.push(chunk)
				try {
					const parsed = parseResponse(Buffer.concat(chunks))
					if (!parsed || settled) return
					settled = true
					socket.end()
					resolve(parsed.value)
				} catch(error) { fail(error) }
			})
		}
	)
	return {
		command,
		async eval<T>(script, keys, args) {
			return await command(['EVAL', script, keys.length, ...keys, ...args]) as T
		}
	}
}

const metadata = (overrides: Record<string, unknown> = {}) => ({
	key: 'a', namespace: 'app', version: 'v1',
	createdAt: 0, staleAt: 100, expiresAt: 120,
	negative: false, sizeBytes: 1, ...overrides
})

live('Redis cache backend live conformance', () => {
	it('executes atomic set/read/delete/invalidate scripts against Redis', async() => {
		const redis = createLiveRedisPort()
		await redis.command(['FLUSHDB'])
		const clock = createFixedClock(0)
		const backend = createRedisCacheBackend({clock, redis, keyPrefix: 'live'})
		await backend.setMany([
			{key: 'app:v1:a', value: new Uint8Array([0]), metadata: metadata()},
			{key: 'app:v2:b', value: new Uint8Array([255]), metadata: metadata({key: 'b', version: 'v2'})}
		])
		expect((await backend.get('app:v1:a', {namespace: 'app', version: 'v1'}))?.value).toEqual(new Uint8Array([0]))
		expect((await backend.getMany(
			['app:v1:a'],
			{namespace: 'app', version: 'v1'}
		)).get('app:v1:a')?.value).toEqual(new Uint8Array([0]))
		expect((await backend.get('app:v2:b', {namespace: 'app', version: 'v2'}))?.value).toEqual(new Uint8Array([255]))

		expect(await backend.invalidate({namespace: 'app', version: 'v1'})).toBe(1)
		expect(await backend.get('app:v1:a', {namespace: 'app', version: 'v1'})).toBeUndefined()
		expect(await backend.delete(['app:v2:b'])).toBe(1)
	})

	it('keeps exact-value cleanup from deleting a concurrent replacement', async() => {
		const base = createLiveRedisPort()
		await base.command(['FLUSHDB'])
		const seed = createRedisCacheBackend({clock: createFixedClock(0), redis: base, keyPrefix: 'live-race'})
		await seed.set('app:v1:a', new Uint8Array([1]), metadata())
		const dataKey = '{live-race}:data:app:v1:a'
		const replacement = await base.command(['GET', dataKey]) as Uint8Array
		await base.command(['SET', dataKey, 'not-json'])
		let replaced = false
		const racingRedis: CacheRedisPort = {
			async eval<T>(script, keys, args) {
				if (!replaced && script === redisCacheDeleteIfValuesScript) {
					replaced = true
					await base.command(['SET', dataKey, replacement])
				}
				return await base.eval<T>(script, keys, args)
			}
		}
		const backend = createRedisCacheBackend({clock: createFixedClock(0), redis: racingRedis, keyPrefix: 'live-race'})

		await expect(backend.get('app:v1:a', {namespace: 'app', version: 'v1'})).resolves.toBeUndefined()
		expect(await base.command(['EXISTS', dataKey])).toBe(1)
		expect((await backend.get('app:v1:a', {namespace: 'app', version: 'v1'}))?.value).toEqual(new Uint8Array([1]))
	})

	it('paginates filtered invalidation without skipping retained registry members', async() => {
		const redis = createLiveRedisPort()
		await redis.command(['FLUSHDB'])
		const backend = createRedisCacheBackend({clock: createFixedClock(0), redis, keyPrefix: 'live-pages'})
		const entries = Array.from({length: 510}, (_, index) => {
			const namespace = index % 2 === 0 ? 'target' : 'retained'
			const key = `key-${String(index).padStart(3, '0')}`
			return {
				key: `${namespace}:v1:${key}`,
				value: new Uint8Array([index % 256]),
				metadata: metadata({key, namespace, staleAt: undefined, expiresAt: undefined})
			}
		})
		await backend.setMany(entries)

		await expect(backend.invalidate({namespace: 'target', version: 'v1'})).resolves.toBe(255)
		expect((await backend.getMany(
			entries.filter((_, index) => index % 2 === 1).map((entry) => entry.key),
			{namespace: 'retained', version: 'v1'}
		)).size).toBe(255)
	})

	it('invalidates every matching member across a registry larger than one batch', async() => {
		const redis = createLiveRedisPort()
		await redis.command(['FLUSHDB'])
		const backend = createRedisCacheBackend({clock: createFixedClock(0), redis, keyPrefix: 'live-large-pages'})
		const entries = Array.from({length: 1_500}, (_, index) => {
			const namespace = index % 2 === 0 ? 'target' : 'retained'
			const key = `key-${String(index).padStart(4, '0')}`
			return {
				key: `${namespace}:v1:${key}`,
				value: new Uint8Array([index % 256]),
				metadata: metadata({key, namespace, staleAt: undefined, expiresAt: undefined})
			}
		})
		await backend.setMany(entries.slice(0, 1_000))
		await backend.setMany(entries.slice(1_000))

		await expect(backend.invalidate({namespace: 'target', version: 'v1'})).resolves.toBe(750)
		expect(await redis.command(['ZCARD', '{live-large-pages}:keys'])).toBe(750)
		await expect(backend.getMany(
			entries.filter((_, index) => index % 2 === 0).map((entry) => entry.key),
			{namespace: 'target', version: 'v1'}
		)).resolves.toEqual(new Map())
		expect((await backend.getMany(
			entries.filter((_, index) => index % 2 === 1).map((entry) => entry.key),
			{namespace: 'retained', version: 'v1'}
		)).size).toBe(750)
	})

	it('does not skip an untouched target when another runtime reorders a retained member', async() => {
		const base = createLiveRedisPort()
		await base.command(['FLUSHDB'])
		const clock = createFixedClock(0)
		const prefix = 'live-reorder'
		const seed = createRedisCacheBackend({clock, redis: base, keyPrefix: prefix})
		const retained = Array.from({length: 500}, (_, index) => {
			const key = `retained-${String(index).padStart(3, '0')}`
			return {
				key: `retained:v1:${key}`,
				value: new Uint8Array([index % 256]),
				metadata: metadata({key, namespace: 'retained', staleAt: 900, expiresAt: 1_000})
			}
		})
		const target = {
			key: 'target:v1:untouched',
			value: new Uint8Array([1]),
			metadata: metadata({key: 'untouched', namespace: 'target', staleAt: 1_900, expiresAt: 2_000})
		}
		await seed.setMany([...retained, target])
		const mover = createRedisCacheBackend({clock, redis: base, keyPrefix: prefix})
		let reordered = false
		const racingRedis: CacheRedisPort = {
			async eval<T>(script, keys, args) {
				const result = await base.eval<T>(script, keys, args)
				if (!reordered && (script.includes('ZRANGE') || script.includes('ZSCAN'))) {
					reordered = true
					await mover.set(retained[0]!.key, retained[0]!.value, {
						...retained[0]!.metadata, staleAt: 2_900, expiresAt: 3_000
					})
				}
				return result
			}
		}
		const invalidator = createRedisCacheBackend({clock, redis: racingRedis, keyPrefix: prefix})

		await expect(invalidator.invalidate({namespace: 'target', version: 'v1'})).resolves.toBe(1)
		expect(reordered).toBe(true)
		await expect(seed.get(target.key, {namespace: 'target', version: 'v1'})).resolves.toBeUndefined()
	})
})
