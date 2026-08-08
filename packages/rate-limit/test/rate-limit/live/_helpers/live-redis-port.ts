/**
 * @file Small RESP-based rate-limit Redis implementation for live integration tests.
 *
 * This stays test-only on purpose so the production package surface does not gain
 * a concrete Redis client dependency just for harness verification.
 */

import {createConnection, type Socket} from 'node:net'

import type {RateLimitRedisPort} from '../../../../src/rate-limit/public/types'

type RedisScalar = string | number
type RedisReply = string | number | null | RedisReply[]

interface ParsedReply {
	value: RedisReply
	bytes: number
}

function encodeCommand(parts: ReadonlyArray<RedisScalar>): string {

	let out = `*${parts.length}\r\n`
	for (const part of parts) {
		const value = String(part)
		out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`
	}
	return out

}

function readLine(buffer: Buffer, offset: number): {line: string; next: number} | null {

	const end = buffer.indexOf('\r\n', offset, 'utf8')
	if (end === -1) {
		return null
	}

	return {
		line: buffer.toString('utf8', offset, end),
		next: end + 2
	}

}

function parseReply(buffer: Buffer, offset = 0): ParsedReply | null {

	if (buffer.length <= offset) {
		return null
	}

	const prefix = String.fromCharCode(buffer[offset] ?? 0)
	const line = readLine(buffer, offset + 1)
	if (!line) {
		return null
	}

	switch (prefix) {
		case '+':
			return {value: line.line, bytes: line.next - offset}
		case '-':
			throw new Error(`Redis error: ${line.line}`)
		case ':':
			return {value: Number(line.line), bytes: line.next - offset}
		case '$': {
			const length = Number(line.line)
			if (length === -1) {
				return {value: null, bytes: line.next - offset}
			}

			const end = line.next + length
			if (buffer.length < end + 2) {
				return null
			}

			return {
				value: buffer.toString('utf8', line.next, end),
				bytes: end + 2 - offset
			}
		}
		case '*': {
			const length = Number(line.line)
			if (length === -1) {
				return {value: null, bytes: line.next - offset}
			}

			const values: RedisReply[] = []
			let cursor = line.next
			for (let i = 0; i < length; i++) {
				const parsed = parseReply(buffer, cursor)
				if (!parsed) {
					return null
				}
				values.push(parsed.value)
				cursor += parsed.bytes
			}

			return {value: values, bytes: cursor - offset}
		}
		default:
			throw new Error(`Unsupported Redis RESP prefix: ${prefix}`)
	}

}

class RespRedisClient {

	private readonly socket: Socket
	private buffer = Buffer.alloc(0)
	private readonly pending: Array<{
		resolve: (value: RedisReply) => void
		reject: (error: Error) => void
	}> = []

	private constructor(socket: Socket) {
		this.socket = socket
		this.socket.on('data', (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk])
			this.flushPending()
		})
		this.socket.on('error', (error) => {
			this.rejectAll(error instanceof Error ? error : new Error(String(error)))
		})
		this.socket.on('close', () => {
			this.rejectAll(new Error('Redis socket closed'))
		})
	}

	static async connect(urlString: string): Promise<RespRedisClient> {

		const url = new URL(urlString)
		if (url.protocol !== 'redis:') {
			throw new Error(`Live Redis harness only supports redis:// URLs, got ${url.protocol}`)
		}

		const port = url.port ? Number(url.port) : 6379
		const host = url.hostname || '127.0.0.1'
		const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0

		const socket = createConnection({host, port})
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', () => resolve())
			socket.once('error', reject)
		})

		const client = new RespRedisClient(socket)
		const username = decodeURIComponent(url.username || '')
		const password = decodeURIComponent(url.password || '')
		if (password) {
			if (username) {
				await client.sendCommand('AUTH', username, password)
			} else {
				await client.sendCommand('AUTH', password)
			}
		}

		if (db > 0) {
			await client.sendCommand('SELECT', db)
		}

		return client

	}

	private flushPending(): void {

		while (this.pending.length > 0) {
			try {
				const parsed = parseReply(this.buffer)
				if (!parsed) {
					return
				}
				this.buffer = this.buffer.subarray(parsed.bytes)
				const next = this.pending.shift()
				next?.resolve(parsed.value)
			} catch(error) {
				const next = this.pending.shift()
				next?.reject(error instanceof Error ? error : new Error(String(error)))
			}
		}

	}

	private rejectAll(error: Error): void {

		while (this.pending.length > 0) {
			const next = this.pending.shift()
			next?.reject(error)
		}

	}

	async sendCommand(...parts: RedisScalar[]): Promise<RedisReply> {

		return new Promise<RedisReply>((resolve, reject) => {
			this.pending.push({resolve, reject})
			this.socket.write(encodeCommand(parts))
		})

	}

	async close(): Promise<void> {

		await new Promise<void>((resolve) => {
			this.socket.end(() => resolve())
		})

	}

}

export class LiveRedisPort implements RateLimitRedisPort {

	readonly ttlUnit = 'ms' as const

	constructor(private readonly client: RespRedisClient) {}

	static async connect(url: string): Promise<LiveRedisPort> {
		return new LiveRedisPort(await RespRedisClient.connect(url))
	}

	async close(): Promise<void> {
		await this.client.close()
	}

	async incrWithExpiry(key: string, ttlMs: number): Promise<number> {
		return this.incrByWithExpiry(key, ttlMs, 1)
	}

	async incrByWithExpiry(key: string, ttlMs: number, amount: number): Promise<number> {

		const result = await this.client.sendCommand(
			'EVAL',
			[
				'local v = redis.call("INCRBY", KEYS[1], ARGV[2])',
				'redis.call("PEXPIRE", KEYS[1], ARGV[1])',
				'return v'
			].join('\n'),
			1,
			key,
			ttlMs,
			amount
		)

		return Number(result)

	}

	async get(key: string): Promise<number | null> {

		const result = await this.client.sendCommand('GET', key)
		if (result === null) {
			return null
		}
		return Number(result)

	}

	async del(key: string): Promise<void> {
		await this.client.sendCommand('DEL', key)
	}

	async setex(key: string, value: number, ttlMs: number): Promise<void> {
		await this.client.sendCommand('SET', key, value, 'PX', ttlMs)
	}

	async ping(): Promise<boolean> {
		return (await this.client.sendCommand('PING')) === 'PONG'
	}

	async deletePattern(pattern: string): Promise<number> {

		let cursor = '0'
		let deleted = 0

		do {
			const reply = await this.client.sendCommand('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100)
			if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[1])) {
				throw new Error('Unexpected SCAN response from live Redis')
			}

			cursor = String(reply[0] ?? '0')
			const keys = reply[1].map((value) => String(value))
			if (keys.length > 0) {
				deleted += Number(await this.client.sendCommand('DEL', ...keys))
			}
		} while (cursor !== '0')

		return deleted

	}

	async pttl(key: string): Promise<number> {
		return Number(await this.client.sendCommand('PTTL', key))
	}

	async expire(key: string, ttlMs: number): Promise<void> {
		await this.client.sendCommand('PEXPIRE', key, ttlMs)
	}

	async expireAt(key: string, timestampMs: number): Promise<void> {
		await this.client.sendCommand('PEXPIREAT', key, timestampMs)
	}

	async eval<T = unknown>(
		script: string,
		keys: ReadonlyArray<string>,
		args: ReadonlyArray<string | number> = []
	): Promise<T> {

		const result = await this.client.sendCommand(
			'EVAL',
			script,
			keys.length,
			...keys,
			...args
		)

		return result as T

	}

}
