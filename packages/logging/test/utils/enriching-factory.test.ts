import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {createEnrichingWithErrorHandling} from '../../src/utils/enriching-factory'

describe('createEnrichingWithErrorHandling', () => {
	it('should wrap enriching function and return result on success', async() => {
		const mockEnriching = vi.fn().mockResolvedValue({
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {namespace: 'test'}
		})

		const enriching = createEnrichingWithErrorHandling(mockEnriching, {
			stage: 'enriching',
			step: 'test'
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(mockEnriching).toHaveBeenCalledWith(record, {})
		expect(result.context?.namespace).toBe('test')
	})

	it('should return original record on error', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		const mockEnriching = vi.fn().mockRejectedValue(new Error('Enriching failed'))

		const enriching = createEnrichingWithErrorHandling(mockEnriching, {
			stage: 'enriching',
			step: 'test'
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const result = await enriching(record, {errors: mockErrors})

		expect(result).toEqual(record)
		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('should handle sync enriching function', async() => {
		const mockEnriching = vi.fn().mockReturnValue({
			level: 'info',
			message: 'test',
			time: 1234567890000,
			context: {namespace: 'test'}
		})

		const enriching = createEnrichingWithErrorHandling(mockEnriching, {
			stage: 'enriching',
			step: 'test'
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(mockEnriching).toHaveBeenCalledWith(record, {})
		expect(result.context?.namespace).toBe('test')
	})

	it('should handle sync enriching function error', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		const mockEnriching = vi.fn().mockImplementation(() => {
			throw new Error('Sync enriching failed')
		})

		const enriching = createEnrichingWithErrorHandling(mockEnriching, {
			stage: 'enriching',
			step: 'test'
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const result = await enriching(record, {errors: mockErrors})

		expect(result).toEqual(record)
		expect(mockErrors.report).toHaveBeenCalled()
	})

	it('should handle error without errors service', async() => {
		const mockEnriching = vi.fn().mockRejectedValue(new Error('Enriching failed'))

		const enriching = createEnrichingWithErrorHandling(mockEnriching, {
			stage: 'enriching',
			step: 'test'
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const result = await enriching(record, {})

		expect(result).toEqual(record)
	})

	it('should pass enriching options to wrapped function', async() => {
		const mockEnriching = vi.fn().mockResolvedValue({
			level: 'info',
			message: 'test',
			time: 1234567890000
		})

		const enriching = createEnrichingWithErrorHandling(mockEnriching, {
			stage: 'enriching',
			step: 'test'
		})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		const options = {
			context: {namespace: 'test'},
			providers: [],
			derive: {dedupeKey: true}
		}

		await enriching(record, options)

		expect(mockEnriching).toHaveBeenCalledWith(record, options)
	})
})
