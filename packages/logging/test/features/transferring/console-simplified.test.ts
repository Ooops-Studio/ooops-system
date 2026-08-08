import {afterEach, describe, expect, it, vi} from 'vitest'

import {consoleSink} from '../../../src/features/transferring/console'

describe('console sink', () => {
	afterEach(() => vi.restoreAllMocks())

	it('writes JSON info logs to stdout and errors to stderr', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		const sink = consoleSink()
		sink.write('{"level":"info","message":"ok"}')
		sink.write('{"level":"error","message":"failed"}')
		expect(stdout).toHaveBeenCalledWith('{"level":"info","message":"ok"}\n')
		expect(stderr).toHaveBeenCalledWith('{"level":"error","message":"failed"}\n')
	})

	it('routes by the top-level JSON level when nested data tries to spoof it', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		const line = '{"attributes":{"level":"info"},"level":"error","message":"failed"}'

		consoleSink().write(line)

		expect(stderr).toHaveBeenCalledWith(`${line}\n`)
		expect(stdout).not.toHaveBeenCalled()
	})

	it('falls back safely for malformed JSON-looking lines', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

		consoleSink().write('{"level":"error"')

		expect(stdout).toHaveBeenCalledWith('{"level":"error"\n')
		expect(stderr).not.toHaveBeenCalled()
	})
})
