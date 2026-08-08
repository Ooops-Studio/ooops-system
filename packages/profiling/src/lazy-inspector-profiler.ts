import type {Clock} from '@ooopsstudio/core/contracts/clock'
import type {CpuProfileArtifact, CpuProfiler} from '@ooopsstudio/core/ports/profiling'

export function createLazyInspectorProfiler(clock: Clock): CpuProfiler {
	let profiler: CpuProfiler | undefined
	let loading: Promise<CpuProfiler> | undefined
	const resolve = async(): Promise<CpuProfiler> => {
		if (profiler) return profiler
		if (!loading) {
			const pending = import('./inspector-profiler').then(({createInspectorProfiler}) => {
				profiler = createInspectorProfiler({clock})
				return profiler
			})
			loading = pending
			void pending.catch(() => { if (loading === pending) loading = undefined })
		}
		return await loading
	}
	return {
		async capture(options: Parameters<CpuProfiler['capture']>[0]): Promise<CpuProfileArtifact> {
			return (await resolve()).capture(options)
		},
		async flush(): Promise<void> { await profiler?.flush?.() },
		async shutdown(): Promise<void> {
			try { await loading } catch { return }
			await profiler?.shutdown?.()
		}
	}
}
