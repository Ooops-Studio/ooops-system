/**
 * @file Error deduplication cache - short TTL, frequency-based for error deduplication.
 */

import type {ObservabilityTap} from '../types/observability'
import {createSafeObserve} from '../utils/safe-observe'

import {BaseCache, type BaseCacheEntry, type BaseCacheOptions} from './base-cache'

const MAX_PENDING_DEDUPLICATION_OPERATIONS = 1_000
const MAX_PENDING_DEDUPLICATION_OPERATIONS_PER_KEY = 64
const MAX_DEDUPLICATION_INPUT_LENGTH = 4_096

/**
 * Hash entry for error deduplication cache with frequency tracking
 */
interface ErrorDeduplicationEntry extends BaseCacheEntry {
	count: number
	weightedScore: number
	/** Escalation metadata for severity escalation cooldown */
	escalation?: {
		timestamp: number
		severity: 'warn' | 'error' | 'fatal'
	}
}

/**
 * Options for error deduplication cache
 */
export interface ErrorDeduplicationCacheOptions extends BaseCacheOptions {
	readonly frequencyThreshold?: number
	readonly observe?: ObservabilityTap
	/** Runtime clock used for TTL decisions. Defaults to Date.now. */
	readonly now?: () => number
}

/**
 * Error deduplication cache with frequency tracking and LRU eviction
 */
export class ErrorDeduplicationCache extends BaseCache<ErrorDeduplicationEntry> {
	private readonly frequencyThreshold: number
	private readonly now: () => number
	private throttledKeys = new Set<string>()
	private readonly keyOperations = new Map<string, Promise<void>>()
	private readonly pendingByKey = new Map<string, number>()
	private pendingOperations = 0
	private readonly safeObserver: ObservabilityTap

	constructor(options: ErrorDeduplicationCacheOptions) {
		super(options)
		if (options.frequencyThreshold !== undefined
			&& (!Number.isSafeInteger(options.frequencyThreshold) || options.frequencyThreshold <= 0)) {
			throw new RangeError('Error deduplication frequencyThreshold must be a positive safe integer')
		}
		if (options.now !== undefined && typeof options.now !== 'function') {
			throw new TypeError('Error deduplication now must be a function')
		}
		if (options.observe !== undefined && typeof options.observe !== 'function') {
			throw new TypeError('Error deduplication observe must be a function')
		}
		this.frequencyThreshold = options.frequencyThreshold ?? 10
		this.now = options.now ?? Date.now
		this.safeObserver = createSafeObserve(options.observe)
	}

	protected override onEntryRemoved(key: string): void {
		this.throttledKeys.delete(key)
	}

	private readNow(): number {
		try {
			const value = this.now()
			if (Number.isSafeInteger(value) && value >= 0) return value
		} catch {
			// Fall through to the system clock.
		}
		try {
			const value = Date.now()
			return Number.isSafeInteger(value) && value >= 0 ? value : 0
		} catch { return 0 }
	}

	override clearExpired(): void {
		const now = this.readNow()
		for (const [key, entry] of this.cache.entries()) {
			const elapsed = now - entry.timestamp
			if (elapsed < 0 || elapsed >= this.ttl) {
				this.cache.delete(key)
				this.onEntryRemoved(key)
			}
		}
	}

	private safeObserve(event: string, data: unknown): void {
		this.safeObserver(event as never, data as never)
	}

	/**
	 * Serialize HashEntry to JSON for external cache storage
	 */
	protected serializeEntry(entry: ErrorDeduplicationEntry): string {
		return JSON.stringify({
			timestamp: entry.timestamp,
			count: entry.count,
			lastAccess: entry.lastAccess,
			weightedScore: entry.weightedScore,
			escalation: entry.escalation
		})
	}

	/**
	 * Deserialize HashEntry from JSON stored in external cache
	 */
	protected deserializeEntry(value: string): ErrorDeduplicationEntry | null {
		try {
			if (value.length > 16_384) return null
			const parsed = JSON.parse(value)
			const validTimestamp = (candidate: unknown): candidate is number =>
				typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
			const validCount = (candidate: unknown): candidate is number =>
				typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
			const lastAccess = parsed?.lastAccess ?? parsed?.timestamp
			const weightedScore = parsed?.weightedScore ?? parsed?.count
			if (validTimestamp(parsed?.timestamp) && validCount(parsed?.count)
				&& validTimestamp(lastAccess) && lastAccess >= parsed.timestamp
				&& typeof weightedScore === 'number' && Number.isFinite(weightedScore)
				&& weightedScore >= 0 && weightedScore <= parsed.count) {
				const entry: ErrorDeduplicationEntry = {
					timestamp: parsed.timestamp,
					count: parsed.count,
					lastAccess,
					weightedScore
				}
				// Conditionally add escalation to satisfy exactOptionalPropertyTypes
				if (parsed.escalation && validTimestamp(parsed.escalation.timestamp)
					&& (parsed.escalation.severity === 'warn'
						|| parsed.escalation.severity === 'error'
						|| parsed.escalation.severity === 'fatal')) {
					entry.escalation = {
						timestamp: parsed.escalation.timestamp,
						severity: parsed.escalation.severity
					}
				}
				return entry
			}
		} catch {
			// Invalid JSON or structure - treat as legacy '1' value
		}
		return null
	}

	/**
	 * Calculate weighted frequency score (decay over time)
	 */
	private calculateWeightedScore(entry: ErrorDeduplicationEntry, now: number): number {
		const ageMs = now - entry.timestamp
		const ageFactor = Math.min(1, Math.max(0, 1 - (ageMs / this.ttl)))
		return entry.count * ageFactor
	}

	private incrementCount(entry: ErrorDeduplicationEntry): void {
		if (entry.count < Number.MAX_SAFE_INTEGER) entry.count++
	}

	/**
	 * Check if an error should be reported (not a duplicate or throttled)
	 */
	async shouldReport(
		key: string,
		errorKind: string,
		errorCategory: string,
		correlationId?: string
	): Promise<boolean> {
		if (typeof key !== 'string' || key.length === 0 || key.length > MAX_DEDUPLICATION_INPUT_LENGTH
			|| typeof errorKind !== 'string' || errorKind.length > MAX_DEDUPLICATION_INPUT_LENGTH
			|| typeof errorCategory !== 'string' || errorCategory.length > MAX_DEDUPLICATION_INPUT_LENGTH
			|| (correlationId !== undefined && (typeof correlationId !== 'string'
				|| correlationId.length > MAX_DEDUPLICATION_INPUT_LENGTH))) return true
		const pendingForKey = this.pendingByKey.get(key) ?? 0
		if (this.pendingOperations >= MAX_PENDING_DEDUPLICATION_OPERATIONS
			|| pendingForKey >= MAX_PENDING_DEDUPLICATION_OPERATIONS_PER_KEY) return true
		this.pendingOperations++
		this.pendingByKey.set(key, pendingForKey + 1)
		const previous = this.keyOperations.get(key) ?? Promise.resolve()
		const operation = previous.then(
			async() => await this.shouldReportUnlocked(key, errorKind, errorCategory, correlationId),
			async() => await this.shouldReportUnlocked(key, errorKind, errorCategory, correlationId)
		)
		const tail = operation.then(() => undefined, () => undefined)
		this.keyOperations.set(key, tail)
		try {
			return await operation
		} finally {
			if (this.keyOperations.get(key) === tail) this.keyOperations.delete(key)
			this.pendingOperations--
			const remaining = (this.pendingByKey.get(key) ?? 1) - 1
			if (remaining === 0) this.pendingByKey.delete(key)
			else this.pendingByKey.set(key, remaining)
		}
	}

	private async shouldReportUnlocked(
		key: string,
		errorKind: string,
		errorCategory: string,
		correlationId?: string
	): Promise<boolean> {
		const now = this.readNow()

		// Check if this key is throttled
		if (this.throttledKeys.has(key)) {
			// Throttling is scoped to the deduplication TTL. Checking expiry here is
			// essential: returning early used to suppress throttled keys forever.
			const throttledEntry = await this.getEntry(key)
			if (!throttledEntry) {
				// LRU eviction can remove the entry independently of this auxiliary set.
				this.throttledKeys.delete(key)
			} else if (now - throttledEntry.timestamp < 0 || now - throttledEntry.timestamp >= this.ttl) {
				this.throttledKeys.delete(key)
				throttledEntry.timestamp = now
				throttledEntry.count = 1
				throttledEntry.lastAccess = now
				throttledEntry.weightedScore = 1
				await this.setEntry(key, throttledEntry)
				return true
			} else {
				this.incrementCount(throttledEntry)
				throttledEntry.lastAccess = now
				throttledEntry.weightedScore = this.calculateWeightedScore(throttledEntry, now)
				await this.setEntry(key, throttledEntry)
				return false
			}
		}

		// Updating an existing key must not evict unrelated entries (or the key
		// itself). Reserve capacity only when this operation can admit a new
		// in-memory or external entry.
		if (!this.cache.has(key)) this.evictLRU()

		// Try external cache first if available
		const entry = await this.getEntry(key)

		if (!entry) {
			// New entry - create and report
			const newEntry: ErrorDeduplicationEntry = {
				timestamp: now,
				count: 1,
				lastAccess: now,
				weightedScore: 1
			}
			await this.setEntry(key, newEntry)
			return true
		}

		// Update access time
		entry.lastAccess = now

		// Check if entry has expired
		if (now - entry.timestamp < 0 || now - entry.timestamp >= this.ttl) {
			entry.timestamp = now
			entry.count = 1
			entry.weightedScore = 1
			this.throttledKeys.delete(key)
			await this.setEntry(key, entry)
			return true
		}

		// Entry exists and is within TTL - increment count and update score
		this.incrementCount(entry)
		entry.weightedScore = this.calculateWeightedScore(entry, now)
		await this.setEntry(key, entry)

		// Check frequency threshold for throttling
		if (entry.count >= this.frequencyThreshold && !this.throttledKeys.has(key)) {
			this.throttledKeys.add(key)

			// Emit throttled event
			this.safeObserve('error:throttled', {
				kind: errorKind,
				category: errorCategory,
				key,
				count: entry.count,
				threshold: this.frequencyThreshold,
				correlationId
			})
		}

		// If throttled or duplicate, don't report
		return false
	}

	/**
	 * Get frequency information for a cache key
	 */
	async getFrequency(key: string): Promise<{count: number; timestamp: number} | undefined> {
		const entry = await this.getEntry(key)
		if (entry) {
			return {
				count: entry.count,
				timestamp: entry.timestamp
			}
		}
		return undefined
	}

	/**
	 * Get escalation metadata for a cache key
	 */
	async getEscalationMetadata(key: string): Promise<{timestamp: number; severity: 'warn' | 'error' | 'fatal'} | undefined> {
		const entry = await this.getEntry(key)
		return entry?.escalation
	}

	/**
	 * Set escalation metadata for a cache key
	 */
	async setEscalationMetadata(key: string, escalation: {timestamp: number; severity: 'warn' | 'error' | 'fatal'}): Promise<void> {
		const entry = await this.getEntry(key)
		if (entry) {
			entry.escalation = escalation
			await this.setEntry(key, entry)
		} else {
			// Create new entry with escalation metadata
			const now = this.readNow()
			const newEntry: ErrorDeduplicationEntry = {
				timestamp: now,
				count: 1,
				lastAccess: now,
				weightedScore: 1,
				escalation
			}
			await this.setEntry(key, newEntry)
		}
	}

	/**
	 * Reset cache to initial state (test utility)
	 */
	reset(): void {
		this.cache.clear()
		this.throttledKeys.clear()
	}
}

/**
 * Create an error deduplication cache instance
 */
export function createErrorDeduplicationCache(
	options: ErrorDeduplicationCacheOptions
): ErrorDeduplicationCache {
	return new ErrorDeduplicationCache(options)
}
