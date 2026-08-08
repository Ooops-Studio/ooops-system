import {MAX_ACTIVE_CACHE_OPERATIONS, MAX_TRACKED_FLIGHTS} from './runtime-safety'

type RuntimeState = 'running' | 'draining' | 'closed'

export interface CacheRuntimeTracker {
	assertActive(): void
	run<T>(operation: () => Promise<T>): Promise<T>
	singleFlight<T>(key: string, operation: () => Promise<T>): Promise<T>
	waitForActiveOperations(): Promise<void>
	beginShutdown(): Promise<void>
	close(): void
	isActive(): boolean
	isClosed(): boolean
	getState(): RuntimeState
	getActiveOperations(): number
}

export function createCacheRuntimeTracker(
	onFlightOverflow: () => void,
	onFlightEvent?: (event: 'started' | 'joined' | 'completed' | 'overflow', activeFlights: number) => void,
	onActiveOperationsChanged?: (activeOperations: number) => void
): CacheRuntimeTracker {
	const activeOperations = new Set<Promise<unknown>>()
	const flights = new Map<string, Promise<unknown>>()
	let state: RuntimeState = 'running'
	let overflowReported = false

	const ensureOpen = (): void => {
		if (state !== 'running') {
			throw new Error(state === 'closed' ? 'Cache has been shut down' : 'Cache is shutting down')
		}
	}

	return {
		assertActive: ensureOpen,
		async run<T>(operation: () => Promise<T>): Promise<T> {
			ensureOpen()
			if (activeOperations.size >= MAX_ACTIVE_CACHE_OPERATIONS) {
				throw new Error('Cache active operation capacity exceeded')
			}
			let pending: Promise<T>
			try { pending = operation() } catch(error) { pending = Promise.reject(error) }
			activeOperations.add(pending)
			onActiveOperationsChanged?.(activeOperations.size)
			void pending.then(
				() => { activeOperations.delete(pending); onActiveOperationsChanged?.(activeOperations.size) },
				() => { activeOperations.delete(pending); onActiveOperationsChanged?.(activeOperations.size) }
			)
			return pending
		},
		async singleFlight<T>(key: string, operation: () => Promise<T>): Promise<T> {
			const existing = flights.get(key)
			if (existing) { onFlightEvent?.('joined', flights.size); return existing as Promise<T> }
			if (flights.size >= MAX_TRACKED_FLIGHTS) {
				if (!overflowReported) { overflowReported = true; onFlightOverflow() }
				onFlightEvent?.('overflow', flights.size)
				throw new Error('CACHE_LOAD_CAPACITY')
			}
			overflowReported = false
			const pending = operation().finally(() => {
				flights.delete(key)
				onFlightEvent?.('completed', flights.size)
			})
			flights.set(key, pending)
			onFlightEvent?.('started', flights.size)
			return pending
		},
		async waitForActiveOperations(): Promise<void> {
			await Promise.allSettled([...activeOperations])
		},
		async beginShutdown(): Promise<void> {
			if (state === 'closed') return
			state = 'draining'
			await Promise.allSettled([...activeOperations])
		},
		close() { state = 'closed' },
		isActive: () => state === 'running',
		isClosed: () => state === 'closed',
		getState: () => state,
		getActiveOperations: () => activeOperations.size
	}
}
