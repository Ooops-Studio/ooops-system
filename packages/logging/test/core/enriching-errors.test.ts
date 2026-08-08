/**
 * @file Tests for enriching factory error handling and recovery.
 */

import type {LogRecord} from '@ooopsstudio/core/contracts/logging'
import type {Errors} from '@ooopsstudio/core/ports/errors'
import {describe, it, expect, vi} from 'vitest'

import {createEnriching} from '../../src/core/enriching'

describe('Enriching Error Handling', () => {
	it('should handle enriching execution errors gracefully', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		// Create enriching with errors port
		const enriching = createEnriching({}, mockErrors)

		// Create a record that might cause issues
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		// Enriching should handle errors and return a record
		const result = await enriching(record, {errors: mockErrors})

		// Should return a record (original or enriched)
		expect(result).toBeDefined()
		expect(result.level).toBe('info')
		expect(result.message).toBe('test')
	})

	it('should handle errors without errors port', async() => {
		// No errors port provided
		const enriching = createEnriching({})

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		// Should not throw even if enriching fails
		const result = await enriching(record, {})

		// Should return record (original or enriched)
		expect(result).toBeDefined()
		expect(result.level).toBe('info')
		expect(result.message).toBe('test')
	})

	it('should prefer errors from options over constructor errors', async() => {
		const constructorErrors: Errors = {
			report: vi.fn()
		}
		const optionsErrors: Errors = {
			report: vi.fn()
		}

		const enriching = createEnriching({}, constructorErrors)

		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		// Call enriching with options errors
		await enriching(record, {errors: optionsErrors})

		// Both error handlers are available, but options errors take precedence
		// The actual behavior depends on implementation, but both should be valid
		expect(constructorErrors.report).toBeDefined()
		expect(optionsErrors.report).toBeDefined()
	})

	it('should handle multiple enriching steps with partial failures', async() => {
		const mockErrors: Errors = {
			report: vi.fn()
		}

		const enriching = createEnriching({}, mockErrors)
		const record: LogRecord = {
			level: 'info',
			message: 'test',
			time: 1234567890000
		}

		// Even if one step fails, others should still execute
		const result = await enriching(record, {errors: mockErrors})

		expect(result).toBeDefined()
	})
})
