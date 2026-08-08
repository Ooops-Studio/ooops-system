import type {
	LifecycleFlushHook,
	LifecycleHookDisposer,
	LifecycleShutdownContext,
	LifecycleShutdownHookOptions,
	LifecycleStartupContext,
	LifecycleStartupHookOptions,
	LifecycleStartupStage,
	ShutdownHook,
	StartupHook
} from '@ooopsstudio/core/contracts/lifecycle'

import {
	MAX_SHUTDOWN_HOOKS,
	MAX_STARTUP_HOOKS
} from '../constants'

import {lifecycleIdentifier, snapshotRecord} from './lifecycle-handler-validation'

export interface StartupHookEntry {
	readonly id: number
	readonly name: string
	readonly stage: LifecycleStartupStage
	readonly hook: StartupHook
	readonly concurrent: boolean
	readonly group?: string
	readonly required: boolean
}

export interface ShutdownHookEntry {
	readonly id: number
	readonly name: string
	readonly group: string
	readonly priority: number
	readonly hook: ShutdownHook
	done: boolean
	physical: Promise<void> | undefined
}

export interface FlushHookEntry {
	readonly id: number
	readonly name: string
	readonly hook: LifecycleFlushHook
	terminalDone: boolean
	physical: Promise<void> | undefined
}

export interface ShutdownHookTier {
	readonly group: string
	readonly priority: number
	readonly entries: readonly ShutdownHookEntry[]
}

const STARTUP_OPTION_FIELDS = new Set(['name', 'concurrent', 'group', 'required'])
const SHUTDOWN_OPTION_FIELDS = new Set(['name', 'priority'])

function disposer(action: () => void): LifecycleHookDisposer {
	let active = true
	return () => {
		if (!active) return
		active = false
		action()
	}
}

export class HookManager {
	private readonly startup = new Map<LifecycleStartupStage, StartupHookEntry[]>()
	private readonly shutdown = new Map<string, ShutdownHookEntry[]>()
	private readonly flush = new Map<string, FlushHookEntry>()
	private nextId = 0
	private startupCount = 0
	private shutdownCount = 0

	constructor(private readonly groups: readonly string[]) {}

	registerStartupHook(
		stage: LifecycleStartupStage,
		hook: StartupHook,
		options?: LifecycleStartupHookOptions
	): LifecycleHookDisposer {
		if (stage !== 'init' && stage !== 'warm' && stage !== 'ready') {
			throw new Error('Lifecycle startup stage is invalid')
		}
		if (typeof hook !== 'function') throw new Error('Lifecycle startup hook must be a function')
		if (this.startupCount >= MAX_STARTUP_HOOKS) throw new Error('Lifecycle startup hook limit exceeded')
		const snapshot = options === undefined ? {} : snapshotRecord(
			options, 'Lifecycle startup hook options', STARTUP_OPTION_FIELDS
		)
		if (snapshot.concurrent !== undefined && typeof snapshot.concurrent !== 'boolean') {
			throw new Error('Lifecycle startup concurrent must be a boolean')
		}
		if (snapshot.required !== undefined && typeof snapshot.required !== 'boolean') {
			throw new Error('Lifecycle startup required must be a boolean')
		}
		if (stage !== 'warm' && snapshot.required === false) {
			throw new Error('Lifecycle init and ready hooks are always required')
		}
		// Option descriptors are caller-controlled and may re-enter registration.
		// Re-check after inspection so nested registrations cannot bypass the cap.
		if (this.startupCount >= MAX_STARTUP_HOOKS) throw new Error('Lifecycle startup hook limit exceeded')
		const id = ++this.nextId
		const name = snapshot.name === undefined
			? `startup-${stage}-${id}`
			: lifecycleIdentifier(snapshot.name, 'Lifecycle startup hook name')
		const group = snapshot.group === undefined
			? undefined
			: lifecycleIdentifier(snapshot.group, 'Lifecycle startup hook group')
		const entry: StartupHookEntry = Object.freeze({
			id,
			name,
			stage,
			hook,
			concurrent: snapshot.concurrent !== false,
			...(group ? {group} : {}),
			required: stage !== 'warm' || snapshot.required === true
		})
		const entries = this.startup.get(stage) ?? []
		entries.push(entry)
		this.startup.set(stage, entries)
		this.startupCount++
		return disposer(() => {
			const current = this.startup.get(stage)
			if (!current) return
			const index = current.indexOf(entry)
			if (index < 0) return
			current.splice(index, 1)
			this.startupCount--
			if (current.length === 0) this.startup.delete(stage)
		})
	}

	registerShutdownHook(
		group: string,
		hook: ShutdownHook,
		options?: LifecycleShutdownHookOptions
	): LifecycleHookDisposer {
		const resolvedGroup = lifecycleIdentifier(group, 'Lifecycle shutdown group')
		if (!this.groups.includes(resolvedGroup)) throw new Error(`Unknown lifecycle shutdown group: ${resolvedGroup}`)
		if (typeof hook !== 'function') throw new Error('Lifecycle shutdown hook must be a function')
		if (this.shutdownCount >= MAX_SHUTDOWN_HOOKS) throw new Error('Lifecycle shutdown hook limit exceeded')
		const snapshot = options === undefined ? {} : snapshotRecord(
			options, 'Lifecycle shutdown hook options', SHUTDOWN_OPTION_FIELDS
		)
		if (snapshot.priority !== undefined && (typeof snapshot.priority !== 'number' || !Number.isFinite(snapshot.priority))) {
			throw new Error('Lifecycle shutdown hook priority must be finite')
		}
		// Keep the bound authoritative even if option inspection registered hooks.
		if (this.shutdownCount >= MAX_SHUTDOWN_HOOKS) throw new Error('Lifecycle shutdown hook limit exceeded')
		const id = ++this.nextId
		const entry: ShutdownHookEntry = {
			id,
			name: snapshot.name === undefined
				? `shutdown-${resolvedGroup}-${id}`
				: lifecycleIdentifier(snapshot.name, 'Lifecycle shutdown hook name'),
			group: resolvedGroup,
			priority: snapshot.priority as number | undefined ?? 100,
			hook,
			done: false,
			physical: undefined
		}
		const entries = this.shutdown.get(resolvedGroup) ?? []
		entries.push(entry)
		this.shutdown.set(resolvedGroup, entries)
		this.shutdownCount++
		return disposer(() => {
			const current = this.shutdown.get(resolvedGroup)
			if (!current) return
			const index = current.indexOf(entry)
			if (index < 0) return
			current.splice(index, 1)
			this.shutdownCount--
			if (current.length === 0) this.shutdown.delete(resolvedGroup)
		})
	}

	registerFlushHook(name: string, hook: LifecycleFlushHook): LifecycleHookDisposer {
		const resolvedName = lifecycleIdentifier(name, 'Lifecycle flush hook name')
		if (typeof hook !== 'function') throw new Error('Lifecycle flush hook must be a function')
		if (this.flush.has(resolvedName)) throw new Error(`Lifecycle flush hook already registered: ${resolvedName}`)
		if (this.flush.size >= MAX_SHUTDOWN_HOOKS) throw new Error('Lifecycle flush hook limit exceeded')
		const entry: FlushHookEntry = {
			id: ++this.nextId,
			name: resolvedName,
			hook,
			terminalDone: false,
			physical: undefined
		}
		this.flush.set(resolvedName, entry)
		return disposer(() => {
			if (this.flush.get(resolvedName) === entry) this.flush.delete(resolvedName)
		})
	}

	startupEntries(stage: LifecycleStartupStage): readonly StartupHookEntry[] {
		return [...(this.startup.get(stage) ?? [])]
	}

	shutdownTiers(): readonly ShutdownHookTier[] {
		const tiers: ShutdownHookTier[] = []
		for (const group of this.groups) {
			const byPriority = new Map<number, ShutdownHookEntry[]>()
			for (const entry of this.shutdown.get(group) ?? []) {
				if (entry.done) continue
				const entries = byPriority.get(entry.priority) ?? []
				entries.push(entry)
				byPriority.set(entry.priority, entries)
			}
			for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
				tiers.push({group, priority, entries: [...(byPriority.get(priority) ?? [])]})
			}
		}
		return tiers
	}

	flushEntries(terminal: boolean): readonly FlushHookEntry[] {
		return [...this.flush.values()].filter((entry) => !terminal || !entry.terminalDone)
	}

	clear(): void {
		this.startup.clear()
		this.shutdown.clear()
		this.flush.clear()
		this.startupCount = 0
		this.shutdownCount = 0
	}
}

export function startupExecutionBatches(
	entries: readonly StartupHookEntry[]
): readonly (readonly StartupHookEntry[])[] {
	const batches: StartupHookEntry[][] = []
	let segment: StartupHookEntry[] = []
	const flushSegment = (): void => {
		if (segment.length === 0) return
		const ungrouped = segment.filter((entry) => !entry.group)
		const grouped = new Map<string, StartupHookEntry[]>()
		for (const entry of segment) {
			if (!entry.group) continue
			const lane = grouped.get(entry.group) ?? []
			lane.push(entry)
			grouped.set(entry.group, lane)
		}
		let round = 0
		do {
			const batch = round === 0 ? [...ungrouped] : []
			for (const lane of grouped.values()) {
				const entry = lane[round]
				if (entry) batch.push(entry)
			}
			if (batch.length > 0) batches.push(batch)
			round++
		} while ([...grouped.values()].some((lane) => lane.length > round))
		segment = []
	}
	for (const entry of entries) {
		if (!entry.concurrent) {
			flushSegment()
			batches.push([entry])
		} else {
			segment.push(entry)
		}
	}
	flushSegment()
	return batches
}

export type {LifecycleShutdownContext, LifecycleStartupContext}
