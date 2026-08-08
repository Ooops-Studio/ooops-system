import {snapshotJobsBackendOperations} from '../features/backends/backend-input-guard'
import type {JobsBackend, JobsBackendRuntime} from '../types/backend'

export function assertCompleteJobsBackend(backend: JobsBackend): JobsBackendRuntime {
	return snapshotJobsBackendOperations(backend)
}

export function assertDurableJobsBackend(backend: JobsBackend): JobsBackendRuntime {
	const snapshot = snapshotJobsBackendOperations(backend)
	if (snapshot.durability !== 'durable') {
		throw new Error('Production jobs scheduler requires an explicit durable backend')
	}
	return snapshot
}
