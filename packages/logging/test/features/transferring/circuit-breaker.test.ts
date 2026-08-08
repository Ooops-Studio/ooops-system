import {describe, it, expect, vi, beforeEach} from 'vitest'

import {createBreaker, canAttemptSend, noteFailure, noteSuccess} from '../../../src/features/transferring/circuit-breaker'
import type {BreakerPolicy, BreakerState} from '../../../src/features/transferring/circuit-breaker'

describe('Circuit Breaker', () => {
	describe('createBreaker', () => {
		it('should create breaker in closed state', () => {
			const breaker = createBreaker(5)

			expect(breaker.state).toBe('closed')
			expect(breaker.consecutiveFailures).toBe(0)
			expect(breaker.halfOpenProbesLeft).toBe(5)
			expect(breaker.openedAt).toBeUndefined()
		})

		it('should set correct max probes', () => {
			const breaker = createBreaker(10)

			expect(breaker.halfOpenProbesLeft).toBe(10)
		})
	})

	describe('canAttemptSend', () => {
		const policy: BreakerPolicy = {
			failureThreshold: 3,
			halfOpenAfterMs: 1000,
			maxHalfOpenProbes: 2
		}

		const mockClock = {
			now: vi.fn().mockReturnValue(1000000)
		}

		const mockOnMark = vi.fn()

		beforeEach(() => {
			vi.clearAllMocks()
			mockClock.now.mockReturnValue(1000000)
		})

		it('should allow send when breaker is closed', () => {
			const breaker: BreakerState = {
				state: 'closed',
				consecutiveFailures: 0,
				halfOpenProbesLeft: 2
			}

			const result = canAttemptSend(breaker, policy, mockClock, mockOnMark)

			expect(result).toBe(true)
			expect(mockOnMark).not.toHaveBeenCalled()
		})

		it('should deny send when breaker is open and not enough time passed', () => {
			const breaker: BreakerState = {
				state: 'open',
				consecutiveFailures: 3,
				openedAt: 1000000,
				halfOpenProbesLeft: 2
			}

			// Only 500ms passed, need 1000ms
			mockClock.now.mockReturnValue(1000500)

			const result = canAttemptSend(breaker, policy, mockClock, mockOnMark)

			expect(result).toBe(false)
			expect(mockOnMark).not.toHaveBeenCalled()
		})

		it('should transition to half-open when enough time passed', () => {
			const breaker: BreakerState = {
				state: 'open',
				consecutiveFailures: 3,
				openedAt: 1000000,
				halfOpenProbesLeft: 2
			}

			// 1500ms passed, more than 1000ms threshold
			mockClock.now.mockReturnValue(1001500)

			const result = canAttemptSend(breaker, policy, mockClock, mockOnMark)

			expect(result).toBe(true)
			expect(breaker.state).toBe('half-open')
			expect(breaker.halfOpenProbesLeft).toBe(1)
			expect(mockOnMark).toHaveBeenCalledWith('breaker-half-open')
		})

		it('does not treat backward clock jumps as elapsed recovery time', () => {
			const breaker: BreakerState = {
				state: 'open',
				consecutiveFailures: 3,
				openedAt: 1000000,
				halfOpenProbesLeft: 2
			}

			mockClock.now.mockReturnValue(999000)

			const result = canAttemptSend(breaker, policy, mockClock, mockOnMark)

			expect(result).toBe(false)
			expect(breaker.state).toBe('open')
			expect(mockOnMark).not.toHaveBeenCalled()
		})

		it('should allow send when breaker is half-open and probes available', () => {
			const breaker: BreakerState = {
				state: 'half-open',
				consecutiveFailures: 3,
				halfOpenProbesLeft: 2
			}

			const result = canAttemptSend(breaker, policy, mockClock, mockOnMark)

			expect(result).toBe(true)
			expect(breaker.halfOpenProbesLeft).toBe(1)
			expect(mockOnMark).not.toHaveBeenCalled()
		})

		it('limits concurrent half-open probes to the configured maximum', () => {
			const breaker: BreakerState = {
				state: 'half-open',
				consecutiveFailures: 3,
				halfOpenProbesLeft: 2
			}

			expect(canAttemptSend(breaker, policy, mockClock)).toBe(true)
			expect(canAttemptSend(breaker, policy, mockClock)).toBe(true)
			expect(canAttemptSend(breaker, policy, mockClock)).toBe(false)
			expect(breaker.halfOpenProbesLeft).toBe(0)
		})

		it('should deny send when breaker is half-open and no probes left', () => {
			const breaker: BreakerState = {
				state: 'half-open',
				consecutiveFailures: 3,
				halfOpenProbesLeft: 0
			}

			const result = canAttemptSend(breaker, policy, mockClock, mockOnMark)

			expect(result).toBe(false)
			expect(mockOnMark).not.toHaveBeenCalled()
		})

		it('should handle clock errors gracefully', () => {
			const breaker: BreakerState = {
				state: 'closed',
				consecutiveFailures: 0,
				halfOpenProbesLeft: 2
			}

			const errorClock = {
				now: vi.fn().mockImplementation(() => {
					throw new Error('Clock error')
				})
			}

			const result = canAttemptSend(breaker, policy, errorClock, mockOnMark)

			expect(result).toBe(true)
		})

		it('should handle open state without openedAt timestamp', () => {
			const breaker: BreakerState = {
				state: 'open',
				consecutiveFailures: 3,
				halfOpenProbesLeft: 2
				// openedAt is undefined
			}

			const result = canAttemptSend(breaker, policy, mockClock, mockOnMark)

			expect(result).toBe(false)
		})
	})

	describe('noteFailure', () => {
		const policy: BreakerPolicy = {
			failureThreshold: 3,
			halfOpenAfterMs: 1000,
			maxHalfOpenProbes: 2
		}

		const mockClock = {
			now: vi.fn().mockReturnValue(1000000)
		}

		const mockOnMark = vi.fn()

		beforeEach(() => {
			vi.clearAllMocks()
			mockClock.now.mockReturnValue(1000000)
		})

		it('should increment consecutive failures', () => {
			const breaker: BreakerState = {
				state: 'closed',
				consecutiveFailures: 1,
				halfOpenProbesLeft: 2
			}

			noteFailure(breaker, policy, mockClock, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(2)
			expect(breaker.state).toBe('closed')
			expect(mockOnMark).not.toHaveBeenCalled()
		})

		it('should open breaker when failure threshold reached', () => {
			const breaker: BreakerState = {
				state: 'closed',
				consecutiveFailures: 2,
				halfOpenProbesLeft: 2
			}

			noteFailure(breaker, policy, mockClock, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(3)
			expect(breaker.state).toBe('open')
			expect(breaker.openedAt).toBe(1000000)
			expect(mockOnMark).toHaveBeenCalledWith('breaker-open')
		})

		it('should open breaker immediately when in half-open state', () => {
			const breaker: BreakerState = {
				state: 'half-open',
				consecutiveFailures: 0,
				halfOpenProbesLeft: 1
			}

			noteFailure(breaker, policy, mockClock, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(1)
			expect(breaker.state).toBe('open')
			expect(breaker.openedAt).toBe(1000000)
			expect(mockOnMark).toHaveBeenCalledWith('breaker-open')
		})

		it('should handle clock errors gracefully', () => {
			const breaker: BreakerState = {
				state: 'closed',
				consecutiveFailures: 2,
				halfOpenProbesLeft: 2
			}

			const errorClock = {
				now: vi.fn().mockImplementation(() => {
					throw new Error('Clock error')
				})
			}

			noteFailure(breaker, policy, errorClock, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(3)
			expect(breaker.state).toBe('open')
			expect(breaker.openedAt).toBeDefined()
			expect(mockOnMark).toHaveBeenCalledWith('breaker-open')
		})
	})

	describe('noteSuccess', () => {
		const mockOnMark = vi.fn()

		beforeEach(() => {
			vi.clearAllMocks()
		})

		it('should reset consecutive failures', () => {
			const breaker: BreakerState = {
				state: 'closed',
				consecutiveFailures: 5,
				halfOpenProbesLeft: 2
			}

			noteSuccess(breaker, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(0)
			expect(mockOnMark).not.toHaveBeenCalled()
		})

		it('should close breaker when in open state', () => {
			const breaker: BreakerState = {
				state: 'open',
				consecutiveFailures: 3,
				openedAt: 1000000,
				halfOpenProbesLeft: 2
			}

			noteSuccess(breaker, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(0)
			expect(breaker.state).toBe('closed')
			expect(breaker.openedAt).toBeUndefined()
			expect(mockOnMark).toHaveBeenCalledWith('breaker-closed')
		})

		it('should close breaker when in half-open state', () => {
			const breaker: BreakerState = {
				state: 'half-open',
				consecutiveFailures: 1,
				halfOpenProbesLeft: 0,
				halfOpenInFlight: 1
			}

			noteSuccess(breaker, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(0)
			expect(breaker.state).toBe('closed')
			expect(breaker.openedAt).toBeUndefined()
			expect(mockOnMark).toHaveBeenCalledWith('breaker-closed')
		})

		it('should not call onMark when already closed', () => {
			const breaker: BreakerState = {
				state: 'closed',
				consecutiveFailures: 0,
				halfOpenProbesLeft: 2
			}

			noteSuccess(breaker, mockOnMark)

			expect(breaker.consecutiveFailures).toBe(0)
			expect(breaker.state).toBe('closed')
			expect(mockOnMark).not.toHaveBeenCalled()
		})
	})

	describe('Integration scenarios', () => {
		const policy: BreakerPolicy = {
			failureThreshold: 2,
			halfOpenAfterMs: 1000,
			maxHalfOpenProbes: 1
		}

		const mockClock = {
			now: vi.fn().mockReturnValue(1000000)
		}

		const mockOnMark = vi.fn()

		beforeEach(() => {
			vi.clearAllMocks()
			mockClock.now.mockReturnValue(1000000)
		})

		it('should handle complete circuit breaker lifecycle', () => {
			const breaker = createBreaker(1)

			// Start closed
			expect(canAttemptSend(breaker, policy, mockClock, mockOnMark)).toBe(true)

			// First failure - still closed
			noteFailure(breaker, policy, mockClock, mockOnMark)
			expect(breaker.state).toBe('closed')
			expect(canAttemptSend(breaker, policy, mockClock, mockOnMark)).toBe(true)

			// Second failure - opens circuit
			noteFailure(breaker, policy, mockClock, mockOnMark)
			expect(breaker.state).toBe('open')
			expect(canAttemptSend(breaker, policy, mockClock, mockOnMark)).toBe(false)

			// Wait for half-open timeout
			mockClock.now.mockReturnValue(1001000)
			expect(canAttemptSend(breaker, policy, mockClock, mockOnMark)).toBe(true)
			expect(breaker.state).toBe('half-open')

			// Success in half-open - closes circuit
			noteSuccess(breaker, mockOnMark)
			expect(breaker.state).toBe('closed')
			expect(canAttemptSend(breaker, policy, mockClock, mockOnMark)).toBe(true)
		})

		it('should handle failure in half-open state', () => {
			const breaker: BreakerState = {
				state: 'half-open',
				consecutiveFailures: 0,
				halfOpenProbesLeft: 1
			}

			expect(canAttemptSend(breaker, policy, mockClock, mockOnMark)).toBe(true)

			// Failure in half-open immediately opens circuit
			noteFailure(breaker, policy, mockClock, mockOnMark)
			expect(breaker.state).toBe('open')
			expect(canAttemptSend(breaker, policy, mockClock, mockOnMark)).toBe(false)
		})
	})

	it('isolates throwing transition observers from breaker state changes', () => {
		const policy: BreakerPolicy = {
			failureThreshold: 1,
			halfOpenAfterMs: 1000,
			maxHalfOpenProbes: 1
		}
		const clock = {now: () => 1000}
		const onMark = () => {
			throw new Error('telemetry failed')
		}
		const breaker = createBreaker(1)

		expect(() => noteFailure(breaker, policy, clock, onMark)).not.toThrow()
		expect(breaker.state).toBe('open')
		expect(() => noteSuccess(breaker, onMark)).not.toThrow()
		expect(breaker.state).toBe('closed')
	})
})
