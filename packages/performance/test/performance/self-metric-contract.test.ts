import {readFile, readdir} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

const servicesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, {withFileTypes: true})
	const nested = await Promise.all(entries.map(async(entry) => {
		const path = join(directory, entry.name)
		return entry.isDirectory() ? await sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
	}))
	return nested.flat()
}

describe('performance self-metric contract', () => {
	it('contains exactly the seven bounded internal metric names', async() => {
		const files = await sourceFiles(join(servicesRoot, 'src', 'performance'))
		const names = new Set<string>()
		for (const file of files) {
			const source = await readFile(file, 'utf8')
			for (const match of source.matchAll(/['"](_performance_[a-z0-9_]+)['"]/gu)) names.add(match[1] ?? '')
		}
		expect([...names].sort()).toEqual([
			'_performance_active_measurements',
			'_performance_dropped_total',
			'_performance_export_failures_total',
			'_performance_export_queue_size',
			'_performance_export_retries_total',
			'_performance_finalization_failures_total',
			'_performance_recorded_total'
		])
	})
})
