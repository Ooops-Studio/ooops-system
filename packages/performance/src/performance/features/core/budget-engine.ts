import type {BudgetStatus, BudgetViolation, PerfEvent} from '@ooopsstudio/core/contracts/performance'

import {hasControlCharacters} from '../../utils/safe-identifiers'

export interface BudgetConfig {
	name: string
	pattern?: string
	percentile?: number
	target: number
	window: number
}

export interface BudgetEngine {
	registerBudget(config: BudgetConfig): void
	checkEvent(event: PerfEvent): BudgetViolation[]
	getStatus(name: string): BudgetStatus | undefined
	reset(): void
}

export interface BudgetEngineOptions {
	onViolation?: (violation: BudgetViolation) => void
	now?: () => number
	maxSamplesPerBudget?: number
}

type Sample = {value: number; timestamp: number}
type SampleState = {items: Sample[]; start: number; aboveTarget: number}

const matches = (config: BudgetConfig, eventName: string): boolean => {
	const pattern = config.pattern ?? config.name
	if (!pattern.includes('*')) return eventName === pattern
	let patternIndex = 0
	let nameIndex = 0
	let starIndex = -1
	let retryIndex = 0
	while (nameIndex < eventName.length) {
		if (pattern[patternIndex] === eventName[nameIndex]) {
			patternIndex += 1
			nameIndex += 1
		} else if (pattern[patternIndex] === '*') {
			starIndex = patternIndex++
			retryIndex = nameIndex
		} else if (starIndex >= 0) {
			patternIndex = starIndex + 1
			nameIndex = ++retryIndex
		} else return false
	}
	while (pattern[patternIndex] === '*') patternIndex += 1
	return patternIndex === pattern.length
}

export function createBudgetEngine(options: BudgetEngineOptions = {}): BudgetEngine {
	const now = options.now ?? Date.now
	const maxSamples = options.maxSamplesPerBudget ?? 2_000
	if (!Number.isInteger(maxSamples) || maxSamples <= 0 || maxSamples > 100_000) {
		throw new Error('maxSamplesPerBudget must be 1..100000')
	}
	const budgets = new Map<string, BudgetConfig>()
	const samples = new Map<string, SampleState>()
	const violationTimestamps = new Map<string, number[]>()
	const activeViolations = new Set<string>()
	const lastTimestamps = new Map<string, number>()

	const discardOldest = (state: SampleState, config: BudgetConfig): void => {
		const discarded = state.items[state.start]
		if (discarded && discarded.value > config.target) state.aboveTarget -= 1
		state.start += 1
	}
	const compact = (state: SampleState): void => {
		if (state.start === state.items.length) {
			state.items = []
			state.start = 0
		} else if (state.start >= Math.min(maxSamples, 1_024)) {
			state.items = state.items.slice(state.start)
			state.start = 0
		}
	}
	const prune = (name: string, config: BudgetConfig, timestamp: number): SampleState => {
		const state = samples.get(name) ?? {items: [], start: 0, aboveTarget: 0}
		while ((state.items[state.start]?.timestamp ?? Number.POSITIVE_INFINITY) < timestamp - config.window) {
			discardOldest(state, config)
		}
		compact(state)
		samples.set(name, state)
		return state
	}
	const percentileValue = (state: SampleState, config: BudgetConfig): number => {
		const values = state.items.slice(state.start).map(({value}) => value).sort((left, right) => left - right)
		return values[Math.max(0, Math.ceil((config.percentile ?? 0.95) * values.length) - 1)] ?? 0
	}
	const isViolated = (state: SampleState, config: BudgetConfig): boolean => {
		const count = state.items.length - state.start
		if (count === 0) return false
		const percentileIndex = Math.max(0, Math.ceil((config.percentile ?? 0.95) * count) - 1)
		return state.aboveTarget >= count - percentileIndex
	}
	const pruneViolations = (name: string, config: BudgetConfig, timestamp: number) => {
		const retained = (violationTimestamps.get(name) ?? [])
			.filter((entry) => entry >= timestamp - config.window)
			.slice(-maxSamples)
		violationTimestamps.set(name, retained)
		return retained
	}

	return {
		registerBudget(config) {
			if (typeof config.name !== 'string' || config.name.length > 128 ||
				!/^[a-z_][a-z0-9_.*?-]{0,127}$/i.test(config.name)) {
				throw new Error('Budget name must be a safe identifier of at most 128 characters')
			}
			if (config.pattern !== undefined && (typeof config.pattern !== 'string' || config.pattern.length > 256 ||
				!config.pattern.trim() || hasControlCharacters(config.pattern))) {
				throw new Error(`Budget pattern for "${config.name}" must be a safe pattern of at most 256 characters`)
			}
			if (!Number.isFinite(config.target) || config.target < 0) throw new Error(`Budget target for "${config.name}" must be a non-negative finite number`)
			if (!Number.isFinite(config.window) || config.window <= 0) throw new Error(`Budget window for "${config.name}" must be a positive finite number`)
			if (config.percentile !== undefined && (!Number.isFinite(config.percentile) || config.percentile <= 0 || config.percentile > 1)) {
				throw new Error(`Budget percentile for "${config.name}" must be in (0, 1]`)
			}
			budgets.set(config.name, {...config})
			samples.delete(config.name)
			violationTimestamps.delete(config.name)
			activeViolations.delete(config.name)
			lastTimestamps.delete(config.name)
		},
		checkEvent(event) {
			const found: BudgetViolation[] = []
			for (const config of budgets.values()) {
				if (!matches(config, event.name)) continue
				const timestamp = Math.max(event.end, lastTimestamps.get(config.name) ?? event.end)
				lastTimestamps.set(config.name, timestamp)
				const state = prune(config.name, config, timestamp)
				state.items.push({value: event.duration, timestamp})
				if (event.duration > config.target) state.aboveTarget += 1
				if (state.items.length - state.start > maxSamples) discardOldest(state, config)
				compact(state)
				if (!isViolated(state, config)) {
					activeViolations.delete(config.name)
					continue
				}
				if (activeViolations.has(config.name)) continue
				const actual = percentileValue(state, config)
				const violation = {
					name: config.name,
					target: config.target,
					actual,
					window: config.window,
					diff: actual - config.target
				}
				activeViolations.add(config.name)
				found.push({...violation})
				const history = violationTimestamps.get(config.name) ?? []
				history.push(timestamp)
				violationTimestamps.set(config.name, history.slice(-maxSamples))
				try { options.onViolation?.({...violation}) } catch { /* observers are isolated */ }
			}
			return found
		},
		getStatus(name) {
			const config = budgets.get(name)
			if (!config) return undefined
			const observedAt = now()
			const timestamp = Math.max(observedAt, lastTimestamps.get(name) ?? observedAt)
			const state = prune(name, config, timestamp)
			const current = percentileValue(state, config)
			const violated = current > config.target
			if (!violated) activeViolations.delete(name)
			return Object.freeze({
				name,
				target: config.target,
				current,
				violated,
				violationCount: pruneViolations(name, config, timestamp).length,
				window: config.window
			})
		},
		reset() { samples.clear(); violationTimestamps.clear(); activeViolations.clear(); lastTimestamps.clear() }
	}
}
